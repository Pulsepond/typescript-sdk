import {
  PulsepondConfigurationError,
  PulsepondValidationError,
} from "./errors.js";
import { IdentityManager } from "./identity.js";
import { createUuidV7, isCanonicalAnonymousId } from "./ids.js";
import {
  createEvent,
  MAX_BATCH_EVENTS,
  type EventV1,
  validateEnvironment,
  validateOptionalText,
  validateStorageNamespace,
} from "./protocol.js";
import {
  createBrowserRuntime,
  createServerRuntime,
  type PulsepondRuntime,
  type RuntimeResponse,
} from "./runtime.js";
import type {
  EventProperties,
  IdentityPersistence,
  PulsepondBrowserClient,
  PulsepondConfig,
  PulsepondDiagnostic,
  PulsepondServerClient,
  PulsepondServerConfig,
  PulsepondServerEventContext,
} from "./types.js";

const WRITE_KEY =
  /^ppw_v1_[0-9a-f]{32}_[0-9a-f]{64}$/;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_EVENT_TTL_MS = 23 * 60 * 60 * 1_000;
const MAX_QUEUE_BYTES = 1_000_000;
const MAX_BATCH_BYTES = 60_000;
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1_000;

interface ResolvedConfig {
  readonly endpoint: string;
  readonly writeKey: string;
  readonly environment: string;
  readonly appVersion?: string;
  readonly release?: string;
  readonly platform: "server" | "web";
  readonly persistence?: IdentityPersistence;
  readonly storageNamespace?: string;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly maxQueueSize: number;
  readonly eventTtlMs: number;
  readonly onDiagnostic?: (diagnostic: PulsepondDiagnostic) => void;
}

interface QueuedEvent {
  readonly event: EventV1;
  readonly occurredAtMs: number;
  readonly serializedBytes: number;
  readonly sequence: number;
}

interface Batch {
  readonly events: readonly QueuedEvent[];
  readonly body: string;
}

type DeliveryResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "retry"; readonly retryAfterMs?: number }
  | { readonly kind: "too_large" };

export function createPulsepond(config: PulsepondConfig): PulsepondBrowserClient {
  return createPulsepondWithRuntime(config, createBrowserRuntime());
}

export function createPulsepondWithRuntime(
  config: PulsepondConfig,
  runtime: PulsepondRuntime,
): PulsepondBrowserClient {
  return new PulsepondClientImpl(resolveConfig(config, "web"), runtime);
}

export function createPulsepondServer(
  config: PulsepondServerConfig,
): PulsepondServerClient {
  return createPulsepondServerWithRuntime(config, createServerRuntime());
}

export function createPulsepondServerWithRuntime(
  config: PulsepondServerConfig,
  runtime: PulsepondRuntime,
): PulsepondServerClient {
  const implementation = new PulsepondClientImpl(
    resolveConfig(config, "server"),
    runtime,
  );
  return Object.freeze({
    track: (
      eventName: string,
      context: PulsepondServerEventContext,
      properties?: EventProperties,
    ) => implementation.trackServer(eventName, context, properties),
    flush: () => implementation.flush(),
    shutdown: () => implementation.shutdown(),
  });
}

class PulsepondClientImpl implements PulsepondBrowserClient {
  readonly #config: ResolvedConfig;
  readonly #runtime: PulsepondRuntime;
  readonly #identity: IdentityManager | undefined;
  readonly #removePageHideListener: (() => void) | undefined;
  readonly #queue: QueuedEvent[] = [];
  #queueBytes = 0;
  #sequence = 0;
  #flushTargetSequence = 0;
  #generation = 0;
  #effectiveBatchSize: number;
  #retryBatch: Batch | undefined;
  #retryEventId: string | undefined;
  #retryAttempts = 0;
  #flushTimer: unknown;
  #retryTimer: unknown;
  #inFlight: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #activeAbortController: AbortController | undefined;
  #closing = false;
  #closed = false;

  constructor(config: ResolvedConfig, runtime: PulsepondRuntime) {
    this.#config = config;
    this.#runtime = runtime;
    this.#effectiveBatchSize = config.batchSize;
    if (config.platform === "web") {
      this.#identity = new IdentityManager(
        config.persistence ?? "memory",
        config.storageNamespace,
        runtime,
        (diagnostic) => {
          this.#notify(diagnostic);
        },
      );
      this.#removePageHideListener = runtime.addPageHideListener(() => {
        void this.#flushForPageHide();
      });
    }
  }

  track(
    eventName: string,
    properties?: EventProperties,
  ): string | null {
    const identity = this.#identity;
    if (identity === undefined) {
      throw new PulsepondConfigurationError(
        "Browser event identity is unavailable",
      );
    }
    const now = this.#runtime.now();
    return this.#enqueue(
      eventName,
      identity.current(now),
      properties,
      now,
    );
  }

  trackServer(
    eventName: string,
    context: PulsepondServerEventContext,
    properties?: EventProperties,
  ): string | null {
    validateServerEventContext(context);
    return this.#enqueue(
      eventName,
      context,
      properties,
      this.#runtime.now(),
    );
  }

  #enqueue(
    eventName: string,
    identity: PulsepondServerEventContext,
    properties: EventProperties | undefined,
    now: number,
  ): string | null {
    if (this.#closing || this.#closed) {
      throw new PulsepondValidationError(
        "Pulsepond cannot track after shutdown has started",
      );
    }
    if (
      this.#queue.length >= this.#config.maxQueueSize ||
      this.#queueBytes >= MAX_QUEUE_BYTES
    ) {
      this.#notify({
        code: "queue_full",
        droppedEvents: 1,
        retryable: false,
      });
      return null;
    }

    const event = createEvent({
      anonymousInstallationId: identity.anonymousInstallationId,
      environment: this.#config.environment,
      eventId: createUuidV7(now, this.#runtime.randomBytes),
      eventName,
      occurredAt: new Date(now).toISOString(),
      platform: this.#config.platform,
      byteLength: this.#runtime.byteLength,
      sessionId: identity.sessionId,
      ...(properties === undefined ? {} : { properties }),
      ...(this.#config.appVersion === undefined
        ? {}
        : { appVersion: this.#config.appVersion }),
      ...(this.#config.release === undefined
        ? {}
        : { release: this.#config.release }),
    });
    const serializedBytes = this.#runtime.byteLength(
      JSON.stringify(event),
    );
    if (this.#queueBytes + serializedBytes > MAX_QUEUE_BYTES) {
      this.#notify({
        code: "queue_full",
        droppedEvents: 1,
        retryable: false,
      });
      return null;
    }

    this.#sequence += 1;
    this.#queue.push({
      event,
      occurredAtMs: now,
      serializedBytes,
      sequence: this.#sequence,
    });
    this.#queueBytes += serializedBytes;

    if (this.#queue.length >= this.#effectiveBatchSize) {
      void this.#requestFlush(false);
    } else {
      this.#scheduleFlush();
    }
    return event.event_id;
  }

  flush(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    if (this.#closing) {
      return (
        this.#shutdownPromise ??
        this.#inFlight ??
        Promise.resolve()
      );
    }
    return this.#requestFlush(true);
  }

  #requestFlush(manual: boolean): Promise<void> {
    const targetSequence = this.#queue.at(-1)?.sequence;
    if (targetSequence !== undefined) {
      this.#flushTargetSequence = Math.max(
        this.#flushTargetSequence,
        targetSequence,
      );
    }
    if (!manual && this.#retryTimer !== undefined) {
      return this.#inFlight ?? Promise.resolve();
    }
    if (manual) {
      this.#clearRetryTimer();
    }
    this.#clearFlushTimer();
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    if (targetSequence === undefined) {
      return Promise.resolve();
    }
    return this.#startFlush(targetSequence, false, false);
  }

  reset(): void {
    if (this.#closed) {
      return;
    }
    this.#discardPending();
    this.#identity?.reset(this.#runtime.now());
  }

  optOut(): void {
    if (this.#closed) {
      this.#identity?.clear();
      return;
    }
    this.#removePageHideListener?.();
    this.#discardPending();
    this.#identity?.clear();
    this.#closed = true;
  }

  #discardPending(): void {
    this.#generation += 1;
    this.#clearFlushTimer();
    this.#clearRetryTimer();
    this.#activeAbortController?.abort();
    this.#inFlight = undefined;
    this.#queue.length = 0;
    this.#queueBytes = 0;
    this.#flushTargetSequence = 0;
    this.#resetRetryState();
    this.#effectiveBatchSize = this.#config.batchSize;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }
    this.#shutdownPromise = this.#runShutdown();
    return this.#shutdownPromise;
  }

  async #runShutdown(): Promise<void> {
    this.#closing = true;
    this.#removePageHideListener?.();
    this.#clearFlushTimer();
    this.#clearRetryTimer();
    await this.#inFlight;
    this.#clearRetryTimer();

    const targetSequence = this.#queue.at(-1)?.sequence;
    if (targetSequence !== undefined) {
      await this.#startFlush(targetSequence, true, true);
    }

    const droppedEvents = this.#queue.length;
    if (droppedEvents > 0) {
      this.#notify({
        code: "delivery_failed",
        droppedEvents,
        retryable: false,
      });
    }
    this.#queue.length = 0;
    this.#queueBytes = 0;
    this.#clearRetryTimer();
    this.#closed = true;
    this.#closing = false;
  }

  #startFlush(
    targetSequence: number,
    keepalive: boolean,
    oneBatchOnly: boolean,
  ): Promise<void> {
    this.#flushTargetSequence = Math.max(
      this.#flushTargetSequence,
      targetSequence,
    );
    const generation = this.#generation;
    const promise = this.#runFlush(
      generation,
      keepalive,
      oneBatchOnly,
    ).finally(() => {
      if (this.#inFlight === promise) {
        this.#inFlight = undefined;
      }
      if (
        !this.#closed &&
        !this.#closing &&
        this.#retryTimer === undefined
      ) {
        if (
          !oneBatchOnly &&
          this.#queue.length >= this.#effectiveBatchSize
        ) {
          void this.#requestFlush(false);
        } else {
          this.#scheduleFlush();
        }
      }
    });
    this.#inFlight = promise;
    return promise;
  }

  async #runFlush(
    generation: number,
    keepalive: boolean,
    oneBatchOnly: boolean,
  ): Promise<void> {
    this.#dropStaleEvents();
    let sentBatches = 0;

    while (generation === this.#generation) {
      const batch = this.#nextBatch(this.#flushTargetSequence);
      if (batch === undefined) {
        return;
      }
      const result = await this.#deliver(batch, generation, keepalive);
      if (generation !== this.#generation) {
        return;
      }

      if (result.kind === "accepted") {
        this.#removeBatch(batch);
        this.#resetRetryState();
      } else if (result.kind === "too_large") {
        this.#resetRetryState();
        if (batch.events.length > 1) {
          this.#effectiveBatchSize = Math.max(
            1,
            Math.floor(batch.events.length / 2),
          );
          if (oneBatchOnly) {
            return;
          }
          continue;
        }
        this.#removeBatch(batch);
        this.#notify({
          code: "batch_rejected",
          droppedEvents: 1,
          retryable: false,
          status: 413,
        });
      } else if (result.kind === "rejected") {
        this.#removeBatch(batch);
        this.#notify({
          code: "batch_rejected",
          droppedEvents: batch.events.length,
          retryable: false,
          status: result.status,
        });
        this.#resetRetryState();
      } else {
        if (keepalive) {
          return;
        }
        const shouldContinue = this.#handleRetry(
          batch,
          result.retryAfterMs,
        );
        if (!shouldContinue) {
          return;
        }
      }

      sentBatches += 1;
      if (oneBatchOnly || sentBatches >= 100) {
        return;
      }
    }
  }

  #nextBatch(targetSequence: number): Batch | undefined {
    if (this.#retryBatch !== undefined) {
      return this.#retryBatch;
    }
    const selected: QueuedEvent[] = [];
    let body = "";
    for (const item of this.#queue) {
      if (
        item.sequence > targetSequence ||
        selected.length >= this.#effectiveBatchSize
      ) {
        break;
      }
      const candidate = [...selected, item];
      const candidateBody = JSON.stringify({
        events: candidate.map(({ event }) => event),
      });
      if (
        this.#runtime.byteLength(candidateBody) > MAX_BATCH_BYTES &&
        selected.length > 0
      ) {
        break;
      }
      selected.push(item);
      body = candidateBody;
    }
    return selected.length === 0
      ? undefined
      : { events: selected, body };
  }

  async #deliver(
    batch: Batch,
    generation: number,
    keepalive: boolean,
  ): Promise<DeliveryResult> {
    const controller = this.#runtime.createAbortController();
    this.#activeAbortController = controller;
    const timeout = this.#runtime.setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await this.#runtime.fetch(this.#config.endpoint, {
        body: batch.body,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${this.#config.writeKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        ...(this.#config.platform === "web"
          ? {
              credentials: "omit",
              keepalive,
              mode: "cors",
              referrerPolicy: "no-referrer",
            }
          : {}),
      });
      if (response.status === 202) {
        return { kind: "accepted" };
      }
      if (response.status === 413) {
        return { kind: "too_large" };
      }
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        const retryAfterMs = retryAfter(response, this.#runtime.now());
        return retryAfterMs === undefined
          ? { kind: "retry" }
          : { kind: "retry", retryAfterMs };
      }
      return { kind: "rejected", status: response.status };
    } catch {
      return generation === this.#generation
        ? { kind: "retry" }
        : { kind: "rejected", status: 0 };
    } finally {
      this.#runtime.clearTimeout(timeout);
      if (this.#activeAbortController === controller) {
        this.#activeAbortController = undefined;
      }
    }
  }

  #handleRetry(
    batch: Batch,
    retryAfterMs: number | undefined,
  ): boolean {
    const eventId = batch.events[0]?.event.event_id;
    if (eventId === undefined) {
      return false;
    }
    if (this.#retryEventId !== eventId) {
      this.#retryEventId = eventId;
      this.#retryAttempts = 0;
      this.#retryBatch = batch;
    } else if (this.#retryBatch === undefined) {
      this.#retryBatch = batch;
    }
    this.#retryAttempts += 1;
    if (this.#retryAttempts > MAX_RETRIES) {
      this.#removeBatch(batch);
      this.#notify({
        code: "retry_exhausted",
        droppedEvents: batch.events.length,
        retryable: false,
      });
      this.#resetRetryState();
      return true;
    }

    const delay =
      retryAfterMs ?? this.#jitteredRetryDelay(this.#retryAttempts);
    this.#notify({
      code: "delivery_failed",
      droppedEvents: 0,
      retryable: true,
    });
    this.#scheduleRetry(delay);
    return false;
  }

  #jitteredRetryDelay(attempt: number): number {
    const ceiling = Math.min(
      MAX_RETRY_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    );
    const random = new Uint8Array(2);
    this.#runtime.randomBytes(random);
    const value = ((random[0] ?? 0) << 8) | (random[1] ?? 0);
    return Math.floor((value / 0xffff) * ceiling);
  }

  #removeBatch(batch: Batch): void {
    const expectedIds = batch.events.map(({ event }) => event.event_id);
    const actualIds = this.#queue
      .slice(0, expectedIds.length)
      .map(({ event }) => event.event_id);
    if (
      expectedIds.length !== actualIds.length ||
      expectedIds.some((id, index) => id !== actualIds[index])
    ) {
      return;
    }
    for (let index = 0; index < batch.events.length; index += 1) {
      const removed = this.#queue.shift();
      if (removed !== undefined) {
        this.#queueBytes -= removed.serializedBytes;
      }
    }
  }

  #dropStaleEvents(): void {
    const now = this.#runtime.now();
    let droppedEvents = 0;
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index];
      if (
        item !== undefined &&
        now - item.occurredAtMs > this.#config.eventTtlMs
      ) {
        this.#queue.splice(index, 1);
        this.#queueBytes -= item.serializedBytes;
        droppedEvents += 1;
      }
    }
    if (droppedEvents > 0) {
      this.#notify({
        code: "stale_event",
        droppedEvents,
        retryable: false,
      });
      this.#resetRetryState();
    }
  }

  #scheduleFlush(): void {
    if (
      this.#config.flushIntervalMs === 0 ||
      this.#queue.length === 0 ||
      this.#flushTimer !== undefined ||
      this.#retryTimer !== undefined ||
      this.#inFlight !== undefined ||
      this.#closing ||
      this.#closed
    ) {
      return;
    }
    this.#flushTimer = this.#runtime.setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#requestFlush(false);
    }, this.#config.flushIntervalMs);
  }

  #scheduleRetry(delay: number): void {
    if (this.#closed || this.#closing) {
      return;
    }
    this.#clearFlushTimer();
    this.#clearRetryTimer();
    this.#retryTimer = this.#runtime.setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#requestFlush(false);
    }, Math.min(MAX_RETRY_DELAY_MS, Math.max(0, delay)));
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer !== undefined) {
      this.#runtime.clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) {
      this.#runtime.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #resetRetryState(): void {
    this.#retryBatch = undefined;
    this.#retryEventId = undefined;
    this.#retryAttempts = 0;
    this.#clearRetryTimer();
  }

  async #flushForPageHide(): Promise<void> {
    if (
      this.#closed ||
      this.#closing ||
      this.#inFlight !== undefined
    ) {
      return;
    }
    this.#clearFlushTimer();
    this.#clearRetryTimer();
    const targetSequence = this.#queue.at(-1)?.sequence;
    if (targetSequence !== undefined) {
      await this.#startFlush(targetSequence, true, true);
    }
  }

  #notify(diagnostic: PulsepondDiagnostic): void {
    try {
      this.#config.onDiagnostic?.(Object.freeze(diagnostic));
    } catch {
      // Consumer callbacks cannot break collection or expose event data.
    }
  }
}

function resolveConfig(
  config: PulsepondConfig | PulsepondServerConfig,
  platform: "server" | "web",
): ResolvedConfig {
  if (config === null || typeof config !== "object") {
    throw new PulsepondConfigurationError(
      "Pulsepond configuration is required",
    );
  }
  const endpoint = validateEndpoint(config.endpoint);
  if (
    typeof config.writeKey !== "string" ||
    !WRITE_KEY.test(config.writeKey)
  ) {
    throw new PulsepondConfigurationError(
      "writeKey must be a canonical Pulsepond publishable key",
    );
  }
  validateConfigurationField(() => {
    validateEnvironment(config.environment);
    validateOptionalText("appVersion", config.appVersion);
    validateOptionalText("release", config.release);
  });

  const browserConfig = config as PulsepondConfig;
  const persistence = browserConfig.persistence ?? "memory";
  if (platform === "server") {
    if (
      browserConfig.persistence !== undefined ||
      browserConfig.storageNamespace !== undefined
    ) {
      throw new PulsepondConfigurationError(
        "Server clients do not accept browser identity storage options",
      );
    }
  } else {
    if (
      persistence !== "memory" &&
      persistence !== "sessionStorage" &&
      persistence !== "localStorage"
    ) {
      throw new PulsepondConfigurationError(
        "persistence must be memory, sessionStorage, or localStorage",
      );
    }
    if (persistence !== "memory") {
      const storageNamespace = browserConfig.storageNamespace;
      if (storageNamespace === undefined) {
        throw new PulsepondConfigurationError(
          "storageNamespace is required with browser storage",
        );
      }
      validateConfigurationField(() => {
        validateStorageNamespace(storageNamespace);
      });
    }
  }
  if (
    config.onDiagnostic !== undefined &&
    typeof config.onDiagnostic !== "function"
  ) {
    throw new PulsepondConfigurationError(
      "onDiagnostic must be a function",
    );
  }

  const batchSize = boundedInteger(
    "batchSize",
    config.batchSize,
    DEFAULT_BATCH_SIZE,
    1,
    MAX_BATCH_EVENTS,
  );
  const flushIntervalMs = boundedInteger(
    "flushIntervalMs",
    config.flushIntervalMs,
    DEFAULT_FLUSH_INTERVAL_MS,
    0,
    60 * 60 * 1_000,
  );
  const maxQueueSize = boundedInteger(
    "maxQueueSize",
    config.maxQueueSize,
    DEFAULT_MAX_QUEUE_SIZE,
    batchSize,
    10_000,
  );
  const eventTtlMs = boundedInteger(
    "eventTtlMs",
    config.eventTtlMs,
    DEFAULT_EVENT_TTL_MS,
    60_000,
    7 * 24 * 60 * 60 * 1_000,
  );

  return Object.freeze({
    endpoint,
    writeKey: config.writeKey,
    environment: config.environment,
    platform,
    batchSize,
    flushIntervalMs,
    maxQueueSize,
    eventTtlMs,
    ...(config.appVersion === undefined
      ? {}
      : { appVersion: config.appVersion }),
    ...(config.release === undefined
      ? {}
      : { release: config.release }),
    ...(platform === "server" ? {} : { persistence }),
    ...(browserConfig.storageNamespace === undefined
      ? {}
      : { storageNamespace: browserConfig.storageNamespace }),
    ...(config.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: config.onDiagnostic }),
  });
}

function validateServerEventContext(
  context: PulsepondServerEventContext,
): void {
  if (
    context === null ||
    typeof context !== "object" ||
    !isCanonicalAnonymousId(context.anonymousInstallationId) ||
    !isCanonicalAnonymousId(context.sessionId)
  ) {
    throw new PulsepondValidationError(
      "Server event context requires canonical UUIDv4 or UUIDv7 installation and session IDs",
    );
  }
}

function validateEndpoint(value: string): string {
  if (typeof value !== "string") {
    throw new PulsepondConfigurationError(
      "endpoint must be an absolute URL",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new PulsepondConfigurationError(
      "endpoint must be an absolute URL",
    );
  }
  const localHostname =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]";
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && localHostname)
  ) {
    throw new PulsepondConfigurationError(
      "endpoint must use HTTPS, or HTTP on localhost",
    );
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/v1/batch"
  ) {
    throw new PulsepondConfigurationError(
      "endpoint must be an origin followed by the exact /v1/batch path",
    );
  }
  return endpoint.toString();
}

function validateConfigurationField(validation: () => void): void {
  try {
    validation();
  } catch (error) {
    if (error instanceof PulsepondValidationError) {
      throw new PulsepondConfigurationError(error.message);
    }
    throw error;
  }
}

function boundedInteger(
  field: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new PulsepondConfigurationError(
      `${field} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return candidate;
}

function retryAfter(
  response: RuntimeResponse,
  now: number,
): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(
      MAX_RETRY_DELAY_MS,
      Number.parseInt(trimmed, 10) * 1_000,
    );
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(0, date - now),
  );
}
