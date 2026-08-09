import type {
  PulsepondRuntime,
  RuntimeResponse,
  StorageLike,
} from "../src/runtime.js";
import type {
  PulsepondConfig,
  PulsepondServerConfig,
} from "../src/types.js";

export const WRITE_KEY =
  `ppw_v1_${"a".repeat(32)}_${"b".repeat(64)}`;

export function config(
  overrides: Partial<PulsepondConfig> = {},
): PulsepondConfig {
  return {
    endpoint: "http://localhost:8787/v1/batch",
    environment: "test",
    flushIntervalMs: 0,
    writeKey: WRITE_KEY,
    ...overrides,
  };
}

export function serverConfig(
  overrides: Partial<PulsepondServerConfig> = {},
): PulsepondServerConfig {
  return {
    endpoint: "http://localhost:8787/v1/batch",
    environment: "test",
    flushIntervalMs: 0,
    writeKey: WRITE_KEY,
    ...overrides,
  };
}

export class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

export interface RecordedRequest {
  readonly input: string;
  readonly init: RequestInit;
}

interface TimerRecord {
  readonly callback: () => void;
  readonly milliseconds: number;
}

export class FakeRuntime implements PulsepondRuntime {
  nowMs = 1_700_000_000_000;
  randomCounter = 0;
  localStorageReads = 0;
  sessionStorageReads = 0;
  readonly localStorage = new MemoryStorage();
  readonly sessionStorage = new MemoryStorage();
  readonly requests: RecordedRequest[] = [];
  readonly timers = new Map<number, TimerRecord>();
  fetchHandler: (
    input: string,
    init: RequestInit,
  ) => Promise<RuntimeResponse> = async () => response(202);
  pageHideListener: (() => void) | undefined;
  #timerId = 0;

  readonly fetch = async (
    input: string,
    init: RequestInit,
  ): Promise<RuntimeResponse> => {
    this.requests.push({ input, init });
    return this.fetchHandler(input, init);
  };

  readonly now = (): number => this.nowMs;

  readonly randomBytes = (target: Uint8Array): void => {
    for (let index = 0; index < target.length; index += 1) {
      this.randomCounter = (this.randomCounter + 17) % 256;
      target[index] = this.randomCounter;
    }
  };

  readonly byteLength = (value: string): number =>
    new TextEncoder().encode(value).byteLength;

  readonly createAbortController = (): AbortController =>
    new AbortController();

  readonly setTimeout = (
    callback: () => void,
    milliseconds: number,
  ): number => {
    this.#timerId += 1;
    this.timers.set(this.#timerId, { callback, milliseconds });
    return this.#timerId;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  };

  readonly getLocalStorage = (): StorageLike => {
    this.localStorageReads += 1;
    return this.localStorage;
  };

  readonly getSessionStorage = (): StorageLike => {
    this.sessionStorageReads += 1;
    return this.sessionStorage;
  };

  readonly addPageHideListener = (
    callback: () => void,
  ): (() => void) => {
    this.pageHideListener = callback;
    return () => {
      if (this.pageHideListener === callback) {
        this.pageHideListener = undefined;
      }
    };
  };

  nextTimerDelay(): number | undefined {
    return [...this.timers.values()]
      .map(({ milliseconds }) => milliseconds)
      .sort((left, right) => left - right)[0];
  }

  runNextTimer(): void {
    const next = [...this.timers.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        left.milliseconds - right.milliseconds ||
        leftId - rightId,
    )[0];
    if (next === undefined) {
      return;
    }
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

export function response(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): RuntimeResponse {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  return {
    status,
    headers: {
      get: (name) => normalized.get(name.toLowerCase()) ?? null,
    },
  };
}

export function requestBody(
  request: RecordedRequest,
): {
  readonly events: readonly Record<string, unknown>[];
} {
  if (typeof request.init.body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(request.init.body) as {
    readonly events: readonly Record<string, unknown>[];
  };
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
    reject: (error) => {
      rejectPromise?.(error);
    },
  };
}
