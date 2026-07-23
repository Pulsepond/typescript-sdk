export type EventPropertyValue = null | boolean | number | string;

export type EventProperties = Readonly<Record<string, EventPropertyValue>>;

export type IdentityPersistence = "memory" | "localStorage";

export type PulsepondDiagnosticCode =
  | "batch_rejected"
  | "delivery_failed"
  | "queue_full"
  | "retry_exhausted"
  | "stale_event"
  | "storage_unavailable";

export interface PulsepondDiagnostic {
  readonly code: PulsepondDiagnosticCode;
  readonly droppedEvents: number;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface PulsepondConfig {
  /**
   * Exact absolute ingestion URL ending in `/v1/batch`.
   */
  readonly endpoint: string;
  /**
   * Publishable source-scoped write key. This is not an administrative credential.
   */
  readonly writeKey: string;
  readonly environment: string;
  readonly appVersion?: string;
  readonly release?: string;
  /**
   * Identity storage is memory-only unless this is explicitly enabled.
   */
  readonly persistence?: IdentityPersistence;
  /**
   * Required with localStorage persistence so key rotation does not change identity.
   */
  readonly storageNamespace?: string;
  /**
   * Maximum events sent in one request. Defaults to the server bootstrap value of 20.
   */
  readonly batchSize?: number;
  /**
   * Milliseconds before an enqueued batch is flushed. Set to 0 to disable timed flushes.
   */
  readonly flushIntervalMs?: number;
  /**
   * Maximum number of events held in memory. Defaults to 1,000.
   */
  readonly maxQueueSize?: number;
  /**
   * Drop unsent events older than this value. Defaults to 23 hours.
   */
  readonly eventTtlMs?: number;
  /**
   * Receives redacted delivery and lifecycle status. Event bodies and write keys are never passed.
   */
  readonly onDiagnostic?: (diagnostic: PulsepondDiagnostic) => void;
}

export interface PulsepondClient {
  /**
   * Enqueues an explicit event and returns its UUIDv7, or null when the bounded queue is full.
   */
  track(eventName: string, properties?: EventProperties): string | null;
  /**
   * Attempts to deliver queued events. Retryable failures remain queued for bounded retry.
   */
  flush(): Promise<void>;
  /**
   * Clears unsent events and rotates installation and session identifiers.
   */
  reset(): void;
  /**
   * Removes lifecycle listeners and makes one final best-effort flush.
   */
  shutdown(): Promise<void>;
}
