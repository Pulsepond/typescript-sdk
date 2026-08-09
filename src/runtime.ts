import { PulsepondConfigurationError } from "./errors.js";

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface RuntimeResponse {
  readonly headers: {
    get(name: string): string | null;
  };
  readonly status: number;
}

export interface PulsepondRuntime {
  readonly fetch: (
    input: string,
    init: RequestInit,
  ) => Promise<RuntimeResponse>;
  readonly now: () => number;
  readonly randomBytes: (target: Uint8Array) => void;
  readonly byteLength: (value: string) => number;
  readonly createAbortController: () => AbortController;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly getLocalStorage: () => StorageLike | undefined;
  readonly getSessionStorage: () => StorageLike | undefined;
  readonly addPageHideListener: (
    callback: () => void,
  ) => (() => void) | undefined;
}

export function createBrowserRuntime(): PulsepondRuntime {
  const runtime = createStandardRuntime();
  return {
    ...runtime,
    getLocalStorage: () => readStorage("localStorage"),
    getSessionStorage: () => readStorage("sessionStorage"),
    addPageHideListener: (callback) => {
      if (
        typeof globalThis.addEventListener !== "function" ||
        typeof globalThis.removeEventListener !== "function"
      ) {
        return undefined;
      }
      globalThis.addEventListener("pagehide", callback);
      return () => {
        globalThis.removeEventListener("pagehide", callback);
      };
    },
  };
}

export function createServerRuntime(): PulsepondRuntime {
  const runtime = createStandardRuntime();
  return {
    ...runtime,
    getLocalStorage: () => undefined,
    getSessionStorage: () => undefined,
    addPageHideListener: () => undefined,
  };
}

function createStandardRuntime(): Omit<
  PulsepondRuntime,
  "addPageHideListener" | "getLocalStorage" | "getSessionStorage"
> {
  if (typeof globalThis.fetch !== "function") {
    throw new PulsepondConfigurationError(
      "Pulsepond requires the Fetch API",
    );
  }
  if (
    typeof globalThis.crypto !== "object" ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    throw new PulsepondConfigurationError(
      "Pulsepond requires the Web Crypto API",
    );
  }
  if (typeof globalThis.TextEncoder !== "function") {
    throw new PulsepondConfigurationError(
      "Pulsepond requires the TextEncoder API",
    );
  }
  if (typeof globalThis.AbortController !== "function") {
    throw new PulsepondConfigurationError(
      "Pulsepond requires the AbortController API",
    );
  }

  const encoder = new TextEncoder();
  const fetch_ = globalThis.fetch.bind(globalThis);
  const crypto_ = globalThis.crypto;

  return {
    fetch: (input, init) => fetch_(input, init),
    now: () => Date.now(),
    randomBytes: (target) => {
      crypto_.getRandomValues(target as Uint8Array<ArrayBuffer>);
    },
    byteLength: (value) => encoder.encode(value).byteLength,
    createAbortController: () => new AbortController(),
    setTimeout: (callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function readStorage(
  name: "localStorage" | "sessionStorage",
): StorageLike | undefined {
  try {
    const globalWithStorage = globalThis as typeof globalThis & {
      readonly localStorage?: Storage;
      readonly sessionStorage?: Storage;
    };
    return globalWithStorage[name];
  } catch {
    return undefined;
  }
}
