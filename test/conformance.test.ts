import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createPulsepondServerWithRuntime,
  createPulsepondWithRuntime,
} from "../src/client.js";
import {
  config,
  FakeRuntime,
  requestBody,
  serverConfig,
} from "./helpers.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "protocol-fixtures",
);
const schema = JSON.parse(
  await readFile(
    join(fixtureRoot, "event-batch.v1.schema.json"),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({
  allErrors: true,
  formats: {
    "date-time": {
      type: "string",
      validate: (value: string) =>
        Number.isFinite(Date.parse(value)) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value),
    },
  },
  strict: true,
});
const validateSchema = ajv.compile(schema);

describe("Pulsepond v1 conformance", () => {
  it("accepts every canonical valid event-batch fixture", async () => {
    for (const fixture of await readFixtures("valid")) {
      assert.equal(validateBatch(fixture.value), true, fixture.name);
    }
  });

  it("rejects every canonical invalid event-batch fixture", async () => {
    for (const fixture of await readFixtures("invalid")) {
      assert.equal(validateBatch(fixture.value), false, fixture.name);
    }
  });

  it("produces a batch accepted by the canonical schema and semantics", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("view_work", {
      completed: false,
      position: 3,
      work_id: "work_123",
    });

    await client.flush();

    assert.equal(
      validateBatch(requestBody(runtime.requests[0]!)),
      true,
      JSON.stringify(validateSchema.errors),
    );
  });

  it("produces a server batch accepted by the canonical schema and semantics", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondServerWithRuntime(
      serverConfig(),
      runtime,
    );
    client.track(
      "purchase_success",
      {
        anonymousInstallationId:
          "11111111-1111-4111-8111-111111111111",
        sessionId: "0194f677-6a3d-7c19-8b21-cf30a213c010",
      },
      { currency: "JPY", value: 1200 },
    );

    await client.flush();

    assert.equal(
      validateBatch(requestBody(runtime.requests[0]!)),
      true,
      JSON.stringify(validateSchema.errors),
    );
  });
});

async function readFixtures(
  kind: "valid" | "invalid",
): Promise<
  readonly {
    readonly name: string;
    readonly value: unknown;
  }[]
> {
  const directory = join(fixtureRoot, kind);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      value: JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as unknown,
    })),
  );
}

function validateBatch(value: unknown): boolean {
  return validateSchema(value) && validateSemantics(value);
}

function validateSemantics(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    !("events" in value) ||
    !Array.isArray(value.events)
  ) {
    return false;
  }
  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (
      event === null ||
      typeof event !== "object" ||
      !("event_id" in event) ||
      typeof event.event_id !== "string"
    ) {
      return false;
    }
    const eventId = event.event_id.toLowerCase();
    if (eventIds.has(eventId)) {
      return false;
    }
    eventIds.add(eventId);
  }
  return true;
}
