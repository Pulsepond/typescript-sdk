import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PulsepondValidationError } from "../src/errors.js";
import { createEvent } from "../src/protocol.js";

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const baseEvent = {
  anonymousInstallationId:
    "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a10",
  byteLength,
  environment: "production",
  eventId: "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a11",
  eventName: "view_work",
  occurredAt: "2023-07-01T00:00:00.000Z",
  platform: "web",
  sessionId: "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a12",
} as const;

describe("event protocol", () => {
  it("creates a closed, frozen v1 web envelope", () => {
    const source = { work_id: "work_123", completed: false };
    const event = createEvent({
      ...baseEvent,
      appVersion: "1.2.3",
      release: "web@1.2.3",
      properties: source,
    });
    source.work_id = "changed";

    assert.deepEqual(event, {
      anonymous_installation_id:
        "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a10",
      app_version: "1.2.3",
      environment: "production",
      event_id: "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a11",
      event_name: "view_work",
      occurred_at: "2023-07-01T00:00:00.000Z",
      platform: "web",
      properties: { completed: false, work_id: "work_123" },
      release: "web@1.2.3",
      schema_version: 1,
      session_id: "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a12",
    });
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.properties), true);
    assert.equal("url" in event, false);
    assert.equal("user_agent" in event, false);
  });

  it("omits optional app fields rather than serializing undefined", () => {
    const event = createEvent(baseEvent);
    assert.equal("app_version" in event, false);
    assert.equal("release" in event, false);
  });

  it("rejects values JSON would otherwise silently coerce or drop", () => {
    const invalidValues: unknown[] = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      [],
      {},
      1n,
    ];
    for (const value of invalidValues) {
      assert.throws(
        () =>
          createEvent({
            ...baseEvent,
            properties: { invalid: value } as never,
          }),
        PulsepondValidationError,
      );
    }
  });

  it("rejects getters, non-enumerable values, inherited values, and symbols", () => {
    const getter = Object.defineProperty({}, "unsafe", {
      enumerable: true,
      get: () => "value",
    });
    const hidden = Object.defineProperty({}, "unsafe", {
      enumerable: false,
      value: "value",
    });
    const inherited = Object.create({ unsafe: "value" }) as Record<
      string,
      string
    >;
    const symbol = { safe: "value", [Symbol("unsafe")]: "value" };

    for (const properties of [getter, hidden, inherited, symbol]) {
      assert.throws(
        () =>
          createEvent({
            ...baseEvent,
            properties,
          }),
        PulsepondValidationError,
      );
    }
  });

  it("enforces flat bounded ASCII properties and event names", () => {
    assert.throws(
      () =>
        createEvent({
          ...baseEvent,
          eventName: " view_work",
        }),
      PulsepondValidationError,
    );
    assert.throws(
      () =>
        createEvent({
          ...baseEvent,
          properties: { display_name: "François" },
        }),
      PulsepondValidationError,
    );
    assert.throws(
      () =>
        createEvent({
          ...baseEvent,
          properties: { feedback: " private " },
        }),
      PulsepondValidationError,
    );
    assert.throws(
      () =>
        createEvent({
          ...baseEvent,
          properties: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [
              `key_${index}`,
              index,
            ]),
          ),
        }),
      PulsepondValidationError,
    );
  });
});
