import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPulsepondServerWithRuntime } from "../src/client.js";
import { PulsepondConfigurationError, PulsepondValidationError } from "../src/errors.js";
import type { PulsepondServerEventContext } from "../src/types.js";
import {
  FakeRuntime,
  requestBody,
  response,
  serverConfig,
  WRITE_KEY,
} from "./helpers.js";

const CONTEXT: PulsepondServerEventContext = {
  anonymousInstallationId: "11111111-1111-4111-8111-111111111111",
  sessionId: "0194f677-6a3d-7c19-8b21-cf30a213c010",
};

describe("server client", () => {
  it("sends explicit server events without browser lifecycle or storage access", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondServerWithRuntime(
      serverConfig({ appVersion: "1.2.3", release: "api@1.2.3" }),
      runtime,
    );

    const eventId = client.track(
      "purchase_success",
      CONTEXT,
      { currency: "JPY", value: 1200 },
    );
    await client.flush();

    assert.match(eventId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(runtime.localStorageReads, 0);
    assert.equal(runtime.sessionStorageReads, 0);
    assert.equal(runtime.pageHideListener, undefined);
    assert.equal("reset" in client, false);

    const request = runtime.requests[0];
    assert.ok(request);
    assert.equal(request.input, "http://localhost:8787/v1/batch");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.redirect, "error");
    assert.equal("credentials" in request.init, false);
    assert.equal("keepalive" in request.init, false);
    assert.equal("mode" in request.init, false);
    assert.equal("referrerPolicy" in request.init, false);
    assert.deepEqual(request.init.headers, {
      Authorization: `Bearer ${WRITE_KEY}`,
      "Content-Type": "application/json",
    });

    assert.deepEqual(requestBody(request).events[0], {
      anonymous_installation_id: CONTEXT.anonymousInstallationId,
      app_version: "1.2.3",
      environment: "test",
      event_id: eventId,
      event_name: "purchase_success",
      occurred_at: new Date(runtime.nowMs).toISOString(),
      platform: "server",
      properties: { currency: "JPY", value: 1200 },
      release: "api@1.2.3",
      schema_version: 1,
      session_id: CONTEXT.sessionId,
    });
  });

  it("rejects missing or noncanonical caller identity before enqueue", async () => {
    for (const context of [
      undefined,
      { anonymousInstallationId: "user@example.com", sessionId: CONTEXT.sessionId },
      { anonymousInstallationId: CONTEXT.anonymousInstallationId, sessionId: "session-1" },
    ]) {
      const runtime = new FakeRuntime();
      const client = createPulsepondServerWithRuntime(serverConfig(), runtime);
      assert.throws(
        () => client.track("app_open", context as PulsepondServerEventContext),
        PulsepondValidationError,
      );
      await client.flush();
      assert.equal(runtime.requests.length, 0);
    }
  });

  it("uses the shared retry queue without changing a server event", async () => {
    const runtime = new FakeRuntime();
    let attempt = 0;
    runtime.fetchHandler = async () => {
      attempt += 1;
      return response(attempt === 1 ? 503 : 202);
    };
    const client = createPulsepondServerWithRuntime(serverConfig(), runtime);
    client.track("app_open", CONTEXT);

    await client.flush();
    const firstBody = runtime.requests[0]?.init.body;
    await client.flush();

    assert.equal(runtime.requests.length, 2);
    assert.equal(runtime.requests[1]?.init.body, firstBody);
  });

  it("rejects browser identity storage options at the runtime boundary", () => {
    assert.throws(
      () =>
        createPulsepondServerWithRuntime(
          {
            ...serverConfig(),
            persistence: "localStorage",
            storageNamespace: "server",
          } as never,
          new FakeRuntime(),
        ),
      PulsepondConfigurationError,
    );
  });

  it("flushes one final server batch and then rejects tracking", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondServerWithRuntime(serverConfig(), runtime);
    client.track("app_open", CONTEXT);

    await client.shutdown();

    assert.equal(runtime.requests.length, 1);
    assert.equal("keepalive" in runtime.requests[0]!.init, false);
    assert.throws(
      () => client.track("app_open", CONTEXT),
      PulsepondValidationError,
    );
  });
});
