import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPulsepondWithRuntime,
} from "../src/client.js";
import {
  PulsepondConfigurationError,
  PulsepondValidationError,
} from "../src/errors.js";
import type { PulsepondDiagnostic } from "../src/types.js";
import {
  config,
  deferred,
  FakeRuntime,
  requestBody,
  response,
  WRITE_KEY,
} from "./helpers.js";

describe("browser client", () => {
  it("sends the exact authenticated v1 browser request without ambient data", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(
      config({
        appVersion: "1.2.3",
        release: "web@1.2.3",
      }),
      runtime,
    );

    const eventId = client.track("view_work", {
      work_id: "work_123",
    });
    await client.flush();

    assert.match(eventId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(runtime.requests.length, 1);
    const request = runtime.requests[0];
    assert.ok(request);
    assert.equal(request.input, "http://localhost:8787/v1/batch");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.credentials, "omit");
    assert.equal(request.init.referrerPolicy, "no-referrer");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.mode, "cors");
    assert.equal(request.init.keepalive, false);
    assert.deepEqual(request.init.headers, {
      Authorization: `Bearer ${WRITE_KEY}`,
      "Content-Type": "application/json",
    });

    const event = requestBody(request).events[0];
    assert.deepEqual(event, {
      anonymous_installation_id: event?.anonymous_installation_id,
      app_version: "1.2.3",
      environment: "test",
      event_id: eventId,
      event_name: "view_work",
      occurred_at: new Date(runtime.nowMs).toISOString(),
      platform: "web",
      properties: { work_id: "work_123" },
      release: "web@1.2.3",
      schema_version: 1,
      session_id: event?.session_id,
    });
    for (const forbidden of [
      "cookie",
      "referrer",
      "routing",
      "url",
      "user_agent",
      "user_id",
    ]) {
      assert.equal(forbidden in (event ?? {}), false);
    }
  });

  it("retries opaque network failures with a byte-identical frozen batch", async () => {
    const runtime = new FakeRuntime();
    let attempt = 0;
    runtime.fetchHandler = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError("opaque CORS failure");
      }
      return response(202);
    };
    const diagnostics: PulsepondDiagnostic[] = [];
    const client = createPulsepondWithRuntime(
      config({
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      }),
      runtime,
    );

    client.track("audio_play", { work_id: "work_123" });
    await client.flush();
    assert.equal(runtime.requests.length, 1);
    const firstBody = runtime.requests[0]?.init.body;
    assert.equal(runtime.nextTimerDelay() !== undefined, true);

    await client.flush();
    assert.equal(runtime.requests.length, 2);
    assert.equal(runtime.requests[1]?.init.body, firstBody);
    assert.equal(diagnostics[0]?.code, "delivery_failed");
    assert.equal(diagnostics[0]?.droppedEvents, 0);
  });

  it("keeps a failed batch byte-identical when the flush target grows", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("first");
    const firstFlush = client.flush();
    client.track("second");
    const concurrentFlush = client.flush();
    assert.equal(concurrentFlush, firstFlush);
    const failedBody = runtime.requests[0]?.init.body;

    pending.reject(new TypeError("opaque CORS failure"));
    await firstFlush;
    runtime.fetchHandler = async () => response(202);
    await client.flush();

    assert.equal(runtime.requests.length, 3);
    assert.equal(runtime.requests[1]?.init.body, failedBody);
    assert.deepEqual(
      runtime.requests.map((request) =>
        requestBody(request).events.map(({ event_name }) => event_name),
      ),
      [["first"], ["first"], ["second"]],
    );
  });

  it("honors and caps Retry-After without reading a response body", async () => {
    const runtime = new FakeRuntime();
    runtime.fetchHandler = async () =>
      response(429, { "Retry-After": "120" });
    const client = createPulsepondWithRuntime(config(), runtime);

    client.track("audio_play");
    await client.flush();

    assert.equal(runtime.nextTimerDelay(), 30_000);
    client.reset();
  });

  it("exhausts bounded retries and reports a redacted permanent drop", async () => {
    const runtime = new FakeRuntime();
    runtime.fetchHandler = async () => {
      throw new TypeError("network unavailable");
    };
    const diagnostics: PulsepondDiagnostic[] = [];
    const client = createPulsepondWithRuntime(
      config({
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      }),
      runtime,
    );
    client.track("audio_play", { work_id: "private_value" });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await client.flush();
    }
    await client.flush();

    assert.equal(runtime.requests.length, 6);
    const exhausted = diagnostics.find(
      ({ code }) => code === "retry_exhausted",
    );
    assert.deepEqual(exhausted, {
      code: "retry_exhausted",
      droppedEvents: 1,
      retryable: false,
    });
    assert.equal(JSON.stringify(diagnostics).includes("private_value"), false);
    assert.equal(JSON.stringify(diagnostics).includes(WRITE_KEY), false);
  });

  it("splits a 413 batch while preserving event IDs and envelope bytes", async () => {
    const runtime = new FakeRuntime();
    let firstRequest = true;
    runtime.fetchHandler = async () => {
      if (firstRequest) {
        firstRequest = false;
        return response(413);
      }
      return response(202);
    };
    const client = createPulsepondWithRuntime(
      config({ batchSize: 4 }),
      runtime,
    );

    for (let index = 0; index < 4; index += 1) {
      client.track("view_work", { index });
    }
    await client.flush();

    assert.deepEqual(
      runtime.requests.map((request) => requestBody(request).events.length),
      [4, 2, 2],
    );
    const originalEvents = requestBody(runtime.requests[0]!).events;
    const splitEvents = runtime.requests
      .slice(1)
      .flatMap((request) => requestBody(request).events);
    assert.deepEqual(splitEvents, originalEvents);
  });

  it("invalidates a frozen retry snapshot before splitting a 413 batch", async () => {
    const runtime = new FakeRuntime();
    let attempt = 0;
    runtime.fetchHandler = async () => {
      attempt += 1;
      if (attempt === 1) {
        return response(503);
      }
      if (attempt === 2) {
        return response(413);
      }
      return response(202);
    };
    const client = createPulsepondWithRuntime(
      config({ batchSize: 4 }),
      runtime,
    );
    for (let index = 0; index < 4; index += 1) {
      client.track("view_work", { index });
    }

    await client.flush();
    await client.flush();

    assert.deepEqual(
      runtime.requests.map((request) => requestBody(request).events.length),
      [4, 4, 2, 2],
    );
  });

  it("drops terminal client responses without retrying", async () => {
    for (const status of [400, 401, 403, 404, 415]) {
      const runtime = new FakeRuntime();
      runtime.fetchHandler = async () => response(status);
      const diagnostics: PulsepondDiagnostic[] = [];
      const client = createPulsepondWithRuntime(
        config({
          onDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
          },
        }),
        runtime,
      );
      client.track("view_work");

      await client.flush();
      await client.flush();

      assert.equal(runtime.requests.length, 1);
      assert.deepEqual(diagnostics.at(-1), {
        code: "batch_rejected",
        droppedEvents: 1,
        retryable: false,
        status,
      });
    }
  });

  it("coalesces concurrent flushes through the latest requested event", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(config(), runtime);
    const firstId = client.track("first");
    const firstFlush = client.flush();
    const secondId = client.track("second");
    const concurrentFlush = client.flush();

    assert.equal(concurrentFlush, firstFlush);
    assert.equal(runtime.requests.length, 1);
    pending.resolve(response(202));
    await firstFlush;

    assert.equal(runtime.requests.length, 2);
    assert.equal(
      requestBody(runtime.requests[0]!).events[0]?.event_id,
      firstId,
    );
    assert.equal(
      requestBody(runtime.requests[1]!).events[0]?.event_id,
      secondId,
    );
  });

  it("does not let automatic threshold flushes bypass retry backoff", async () => {
    const runtime = new FakeRuntime();
    runtime.fetchHandler = async () => response(503);
    const client = createPulsepondWithRuntime(
      config({ batchSize: 2 }),
      runtime,
    );
    client.track("first");
    await client.flush();
    assert.equal(runtime.nextTimerDelay() !== undefined, true);

    client.track("second");

    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.nextTimerDelay() !== undefined, true);
    client.reset();
  });

  it("fails closed on queue overflow while an earlier batch is in flight", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const diagnostics: PulsepondDiagnostic[] = [];
    const client = createPulsepondWithRuntime(
      config({
        batchSize: 2,
        maxQueueSize: 2,
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      }),
      runtime,
    );

    assert.notEqual(client.track("first"), null);
    assert.notEqual(client.track("second"), null);
    assert.equal(client.track("third"), null);
    assert.deepEqual(diagnostics.at(-1), {
      code: "queue_full",
      droppedEvents: 1,
      retryable: false,
    });

    pending.resolve(response(202));
    await client.flush();
  });

  it("isolates stale events before whole-batch server validation", async () => {
    const runtime = new FakeRuntime();
    const diagnostics: PulsepondDiagnostic[] = [];
    const client = createPulsepondWithRuntime(
      config({
        eventTtlMs: 60_000,
        onDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      }),
      runtime,
    );
    client.track("stale");
    runtime.nowMs += 60_001;

    await client.flush();

    assert.equal(runtime.requests.length, 0);
    assert.deepEqual(diagnostics.at(-1), {
      code: "stale_event",
      droppedEvents: 1,
      retryable: false,
    });
  });

  it("uses an explicit namespace for opt-in identity persistence across key rotation", async () => {
    const runtime = new FakeRuntime();
    const first = createPulsepondWithRuntime(
      config({
        persistence: "localStorage",
        storageNamespace: "museum_web",
      }),
      runtime,
    );
    first.track("first");
    await first.flush();
    const firstInstallationId =
      requestBody(runtime.requests[0]!).events[0]
        ?.anonymous_installation_id;

    const rotatedKey =
      `ppw_v1_${"c".repeat(32)}_${"d".repeat(64)}`;
    const second = createPulsepondWithRuntime(
      config({
        persistence: "localStorage",
        storageNamespace: "museum_web",
        writeKey: rotatedKey,
      }),
      runtime,
    );
    second.track("second");
    await second.flush();
    const secondInstallationId =
      requestBody(runtime.requests[1]!).events[0]
        ?.anonymous_installation_id;

    assert.equal(secondInstallationId, firstInstallationId);
    const storageKeys = [
      ...runtime.localStorage.values.keys(),
      ...runtime.sessionStorage.values.keys(),
    ];
    assert.equal(storageKeys.some((key) => key.includes("ppw_v1")), false);
    assert.equal(
      storageKeys.every((key) => key.includes("museum_web")),
      true,
    );
  });

  it("keeps session-scoped identity across navigation without touching local storage", async () => {
    const runtime = new FakeRuntime();
    const first = createPulsepondWithRuntime(
      config({
        persistence: "sessionStorage",
        storageNamespace: "pulsepond_installer",
      }),
      runtime,
    );
    first.track("install_start");
    await first.flush();

    const second = createPulsepondWithRuntime(
      config({
        persistence: "sessionStorage",
        storageNamespace: "pulsepond_installer",
      }),
      runtime,
    );
    second.track("oauth_complete");
    await second.flush();

    const firstInstallationId =
      requestBody(runtime.requests[0]!).events[0]
        ?.anonymous_installation_id;
    const secondInstallationId =
      requestBody(runtime.requests[1]!).events[0]
        ?.anonymous_installation_id;
    assert.equal(secondInstallationId, firstInstallationId);
    assert.equal(runtime.localStorageReads, 0);
    assert.equal(runtime.localStorage.values.size, 0);
    assert.equal(runtime.sessionStorageReads, 2);
    assert.equal(runtime.sessionStorage.values.size, 2);
  });

  it("does not carry session-scoped identity into fresh storage", async () => {
    const firstRuntime = new FakeRuntime();
    const first = createPulsepondWithRuntime(
      config({
        persistence: "sessionStorage",
        storageNamespace: "pulsepond_installer",
      }),
      firstRuntime,
    );
    first.track("install_start");
    await first.flush();

    const secondRuntime = new FakeRuntime();
    secondRuntime.nowMs += 1;
    const second = createPulsepondWithRuntime(
      config({
        persistence: "sessionStorage",
        storageNamespace: "pulsepond_installer",
      }),
      secondRuntime,
    );
    second.track("install_start");
    await second.flush();

    assert.notEqual(
      requestBody(secondRuntime.requests[0]!).events[0]
        ?.anonymous_installation_id,
      requestBody(firstRuntime.requests[0]!).events[0]
        ?.anonymous_installation_id,
    );
  });

  it("never touches browser storage in the default memory mode", () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("view_work");

    assert.equal(runtime.localStorageReads, 0);
    assert.equal(runtime.sessionStorageReads, 0);
    assert.equal(runtime.localStorage.values.size, 0);
    assert.equal(runtime.sessionStorage.values.size, 0);
  });

  it("reset invalidates in-flight completion and rotates identity", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("before_reset");
    const firstFlush = client.flush();
    const firstBody = requestBody(runtime.requests[0]!);

    client.reset();
    client.track("after_reset");
    pending.resolve(response(202));
    await firstFlush;
    runtime.fetchHandler = async () => response(202);
    await client.flush();
    const secondBody = requestBody(runtime.requests[1]!);

    assert.notEqual(
      firstBody.events[0]?.anonymous_installation_id,
      secondBody.events[0]?.anonymous_installation_id,
    );
    assert.equal(secondBody.events[0]?.event_name, "after_reset");
  });

  it("does not coalesce a new-generation flush with an aborted old request", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("before_reset");
    const oldFlush = client.flush();

    client.reset();
    runtime.fetchHandler = async () => response(202);
    client.track("after_reset");
    const newFlush = client.flush();

    assert.notEqual(newFlush, oldFlush);
    await newFlush;
    assert.equal(runtime.requests.length, 2);
    assert.equal(
      requestBody(runtime.requests[1]!).events[0]?.event_name,
      "after_reset",
    );
    pending.resolve(response(202));
    await oldFlush;
  });

  it("schedules new-generation events after a reset aborts an old flush", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(
      config({ flushIntervalMs: 5_000 }),
      runtime,
    );
    client.track("before_reset");
    const oldFlush = client.flush();

    client.reset();
    client.track("after_reset");
    pending.resolve(response(202));
    await oldFlush;

    assert.equal(runtime.nextTimerDelay(), 5_000);
    runtime.fetchHandler = async () => response(202);
    runtime.runNextTimer();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runtime.requests.length, 2);
    assert.equal(
      requestBody(runtime.requests[1]!).events[0]?.event_name,
      "after_reset",
    );
  });

  it("runs a threshold flush queued behind an old generation", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(
      config({ batchSize: 1 }),
      runtime,
    );
    client.track("before_reset");
    const oldFlush = client.flush();

    client.reset();
    client.track("after_reset");
    pending.resolve(response(202));
    await oldFlush;
    await Promise.resolve();

    assert.equal(runtime.requests.length, 2);
    assert.equal(
      requestBody(runtime.requests[1]!).events[0]?.event_name,
      "after_reset",
    );
  });

  it("uses one best-effort keepalive fetch on pagehide", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("page_hidden");

    runtime.pageHideListener?.();
    await Promise.resolve();

    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0]?.init.keepalive, true);
  });

  it("does not split a rejected pagehide batch into multiple keepalive requests", async () => {
    const runtime = new FakeRuntime();
    runtime.fetchHandler = async () => response(413);
    const client = createPulsepondWithRuntime(
      config({ batchSize: 5 }),
      runtime,
    );
    for (let index = 0; index < 4; index += 1) {
      client.track("page_hidden", { index });
    }

    runtime.pageHideListener?.();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      runtime.requests.map((request) => requestBody(request).events.length),
      [4],
    );
    assert.equal(runtime.requests[0]?.init.keepalive, true);
    client.reset();
  });

  it("removes lifecycle hooks and rejects tracking after shutdown", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("before_shutdown");

    const shutdown = client.shutdown();
    const concurrentShutdown = client.shutdown();
    assert.equal(concurrentShutdown, shutdown);
    await shutdown;

    assert.equal(runtime.pageHideListener, undefined);
    assert.equal(runtime.requests[0]?.init.keepalive, true);
    assert.equal(runtime.timers.size, 0);
    assert.throws(
      () => client.track("after_shutdown"),
      PulsepondValidationError,
    );
  });

  it("does not leave a retry timer when an in-flight request fails during shutdown", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<ReturnType<typeof response>>();
    runtime.fetchHandler = async () => pending.promise;
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("before_shutdown");
    void client.flush();

    const shutdown = client.shutdown();
    pending.resolve(response(503));
    await shutdown;

    assert.equal(runtime.requests.length, 2);
    assert.equal(runtime.requests[1]?.init.keepalive, true);
    assert.equal(runtime.timers.size, 0);
  });

  it("routes flush calls made during shutdown to the same final request", async () => {
    const runtime = new FakeRuntime();
    const client = createPulsepondWithRuntime(config(), runtime);
    client.track("before_shutdown");

    const shutdown = client.shutdown();
    const flush = client.flush();

    assert.equal(flush, shutdown);
    await shutdown;
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0]?.init.keepalive, true);
  });
});

describe("configuration", () => {
  it("requires the exact secure ingestion path and canonical publishable key", () => {
    const runtime = new FakeRuntime();
    for (const endpoint of [
      "https://events.example.com/",
      "https://events.example.com/v1/batch?key=value",
      "http://events.example.com/v1/batch",
      "ftp://localhost/v1/batch",
    ]) {
      assert.throws(
        () =>
          createPulsepondWithRuntime(
            config({ endpoint }),
            runtime,
          ),
        PulsepondConfigurationError,
      );
    }
    assert.throws(
      () =>
        createPulsepondWithRuntime(
          config({ writeKey: "not-a-key" }),
          runtime,
        ),
      PulsepondConfigurationError,
    );
    assert.throws(
      () =>
        createPulsepondWithRuntime(
          config({
            appVersion: 123 as unknown as string,
          }),
          runtime,
        ),
      PulsepondConfigurationError,
    );
  });

  it("requires a caller namespace before enabling browser storage", () => {
    for (const persistence of ["localStorage", "sessionStorage"] as const) {
      assert.throws(
        () =>
          createPulsepondWithRuntime(
            config({ persistence }),
            new FakeRuntime(),
          ),
        PulsepondConfigurationError,
      );
    }
  });
});
