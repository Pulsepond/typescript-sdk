import { createUuidV7, isCanonicalAnonymousId } from "./ids.js";
import type {
  PulsepondDiagnostic,
  IdentityPersistence,
} from "./types.js";
import type {
  PulsepondRuntime,
  StorageLike,
} from "./runtime.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1_000;

interface SessionRecord {
  readonly id: string;
  readonly lastActivityMs: number;
}

export interface Identity {
  readonly anonymousInstallationId: string;
  readonly sessionId: string;
}

export class IdentityManager {
  readonly #installationKey: string;
  readonly #sessionKey: string;
  readonly #runtime: PulsepondRuntime;
  readonly #notify: (diagnostic: PulsepondDiagnostic) => void;
  #localStorage: StorageLike | undefined;
  #sessionStorage: StorageLike | undefined;
  #installationId: string;
  #session: SessionRecord;

  constructor(
    persistence: IdentityPersistence,
    storageNamespace: string | undefined,
    runtime: PulsepondRuntime,
    notify: (diagnostic: PulsepondDiagnostic) => void,
  ) {
    this.#runtime = runtime;
    this.#notify = notify;
    const namespace = storageNamespace ?? "memory";
    this.#installationKey =
      `pulsepond.v1.${namespace}.installation_id`;
    this.#sessionKey = `pulsepond.v1.${namespace}.session`;

    if (persistence === "localStorage") {
      this.#localStorage = runtime.getLocalStorage();
      this.#sessionStorage = runtime.getSessionStorage();
      if (this.#localStorage === undefined) {
        this.#storageUnavailable();
      }
      if (this.#sessionStorage === undefined) {
        this.#storageUnavailable();
      }
    }

    const now = runtime.now();
    this.#installationId =
      this.#readInstallationId() ?? this.#newId(now);
    this.#session = this.#readSession(now) ?? {
      id: this.#newId(now),
      lastActivityMs: now,
    };
    this.#persistInstallation();
    this.#persistSession();
  }

  current(now: number): Identity {
    if (
      now < this.#session.lastActivityMs ||
      now - this.#session.lastActivityMs > SESSION_TIMEOUT_MS
    ) {
      this.#session = {
        id: this.#newId(now),
        lastActivityMs: now,
      };
    } else {
      this.#session = {
        id: this.#session.id,
        lastActivityMs: now,
      };
    }
    this.#persistSession();
    return {
      anonymousInstallationId: this.#installationId,
      sessionId: this.#session.id,
    };
  }

  reset(now: number): void {
    this.#remove(this.#localStorage, this.#installationKey, "local");
    this.#remove(this.#sessionStorage, this.#sessionKey, "session");
    this.#installationId = this.#newId(now);
    this.#session = {
      id: this.#newId(now),
      lastActivityMs: now,
    };
    this.#persistInstallation();
    this.#persistSession();
  }

  #newId(now: number): string {
    return createUuidV7(now, this.#runtime.randomBytes);
  }

  #readInstallationId(): string | undefined {
    const value = this.#read(
      this.#localStorage,
      this.#installationKey,
      "local",
    );
    return value !== undefined && isCanonicalAnonymousId(value)
      ? value
      : undefined;
  }

  #readSession(now: number): SessionRecord | undefined {
    const value = this.#read(
      this.#sessionStorage,
      this.#sessionKey,
      "session",
    );
    if (value === undefined) {
      return undefined;
    }
    try {
      const candidate = JSON.parse(value) as Partial<SessionRecord>;
      const lastActivityMs = candidate.lastActivityMs;
      if (
        typeof candidate.id !== "string" ||
        !isCanonicalAnonymousId(candidate.id) ||
        typeof lastActivityMs !== "number" ||
        !Number.isSafeInteger(lastActivityMs) ||
        lastActivityMs < 0 ||
        lastActivityMs > now ||
        now - lastActivityMs > SESSION_TIMEOUT_MS
      ) {
        return undefined;
      }
      return {
        id: candidate.id,
        lastActivityMs,
      };
    } catch {
      return undefined;
    }
  }

  #persistInstallation(): void {
    this.#write(
      this.#localStorage,
      this.#installationKey,
      this.#installationId,
      "local",
    );
  }

  #persistSession(): void {
    this.#write(
      this.#sessionStorage,
      this.#sessionKey,
      JSON.stringify(this.#session),
      "session",
    );
  }

  #read(
    storage: StorageLike | undefined,
    key: string,
    kind: "local" | "session",
  ): string | undefined {
    if (storage === undefined) {
      return undefined;
    }
    try {
      return storage.getItem(key) ?? undefined;
    } catch {
      this.#disableStorage(kind);
      return undefined;
    }
  }

  #write(
    storage: StorageLike | undefined,
    key: string,
    value: string,
    kind: "local" | "session",
  ): void {
    if (storage === undefined) {
      return;
    }
    try {
      storage.setItem(key, value);
    } catch {
      this.#disableStorage(kind);
    }
  }

  #remove(
    storage: StorageLike | undefined,
    key: string,
    kind: "local" | "session",
  ): void {
    if (storage === undefined) {
      return;
    }
    try {
      storage.removeItem(key);
    } catch {
      this.#disableStorage(kind);
    }
  }

  #disableStorage(kind: "local" | "session"): void {
    if (kind === "local") {
      this.#localStorage = undefined;
    } else {
      this.#sessionStorage = undefined;
    }
    this.#storageUnavailable();
  }

  #storageUnavailable(): void {
    this.#notify({
      code: "storage_unavailable",
      droppedEvents: 0,
      retryable: false,
    });
  }
}
