import { PulsepondValidationError } from "./errors.js";
import type {
  EventProperties,
  EventPropertyValue,
} from "./types.js";

export const EVENT_SCHEMA_VERSION = 1;
export const MAX_BATCH_EVENTS = 100;
export const MAX_EVENT_PROPERTIES = 32;
export const MAX_PROPERTIES_JSON_BYTES = 20_000;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PRINTABLE_ASCII =
  /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

export interface EventV1 {
  readonly anonymous_installation_id: string;
  readonly app_version?: string;
  readonly environment: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly occurred_at: string;
  readonly platform: "server" | "web";
  readonly properties: Readonly<Record<string, EventPropertyValue>>;
  readonly release?: string;
  readonly schema_version: 1;
  readonly session_id: string;
}

interface CreateEventInput {
  readonly anonymousInstallationId: string;
  readonly appVersion?: string;
  readonly environment: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly platform: "server" | "web";
  readonly properties?: EventProperties;
  readonly release?: string;
  readonly byteLength: (value: string) => number;
  readonly sessionId: string;
}

export function createEvent(input: CreateEventInput): EventV1 {
  validateSlug("eventName", input.eventName, 64);
  const properties = validateAndCopyProperties(
    input.properties,
    input.byteLength,
  );

  const event: EventV1 = {
    anonymous_installation_id: input.anonymousInstallationId,
    environment: input.environment,
    event_id: input.eventId,
    event_name: input.eventName,
    occurred_at: input.occurredAt,
    platform: input.platform,
    properties,
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: input.sessionId,
    ...(input.appVersion === undefined
      ? {}
      : { app_version: input.appVersion }),
    ...(input.release === undefined ? {} : { release: input.release }),
  };
  return Object.freeze(event);
}

export function validateEnvironment(value: string): void {
  validateSlug("environment", value, 32);
}

export function validateStorageNamespace(value: string): void {
  validateSlug("storageNamespace", value, 64);
}

export function validateOptionalText(
  field: "appVersion" | "release",
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const maximumLength = field === "appVersion" ? 64 : 128;
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    !PRINTABLE_ASCII.test(value)
  ) {
    throw new PulsepondValidationError(
      `${field} must be trimmed printable ASCII within ${maximumLength} characters`,
    );
  }
}

function validateSlug(
  field: string,
  value: string,
  maximumLength: number,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !SLUG.test(value)
  ) {
    throw new PulsepondValidationError(
      `${field} must be an ASCII slug within ${maximumLength} characters`,
    );
  }
}

function validateAndCopyProperties(
  properties: EventProperties | undefined,
  byteLength: (value: string) => number,
): Readonly<Record<string, EventPropertyValue>> {
  if (properties === undefined) {
    return Object.freeze({});
  }
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    throw new PulsepondValidationError("properties must be a flat object");
  }

  const prototype = Object.getPrototypeOf(properties);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PulsepondValidationError(
      "properties must not contain inherited values",
    );
  }
  if (Object.getOwnPropertySymbols(properties).length > 0) {
    throw new PulsepondValidationError(
      "properties must not contain symbol keys",
    );
  }

  const names = Object.getOwnPropertyNames(properties);
  if (names.length > MAX_EVENT_PROPERTIES) {
    throw new PulsepondValidationError(
      `properties must contain at most ${MAX_EVENT_PROPERTIES} values`,
    );
  }

  const entries: [string, EventPropertyValue][] = [];
  for (const name of [...names].sort()) {
    validateSlug("property name", name, 64);
    const descriptor = Object.getOwnPropertyDescriptor(properties, name);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new PulsepondValidationError(
        "properties must contain enumerable data values only",
      );
    }
    validatePropertyValue(descriptor.value);
    entries.push([name, descriptor.value as EventPropertyValue]);
  }

  const copy = Object.fromEntries(entries) as Record<
    string,
    EventPropertyValue
  >;
  if (byteLength(JSON.stringify(copy)) > MAX_PROPERTIES_JSON_BYTES) {
    throw new PulsepondValidationError(
      `properties must serialize within ${MAX_PROPERTIES_JSON_BYTES} bytes`,
    );
  }
  return Object.freeze(copy);
}

function validatePropertyValue(value: unknown): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new PulsepondValidationError(
        "numeric properties must be safe integers",
      );
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > 256 || !PRINTABLE_ASCII.test(value)) {
      throw new PulsepondValidationError(
        "string properties must be trimmed printable ASCII within 256 characters",
      );
    }
    return;
  }
  throw new PulsepondValidationError(
    "properties may contain only null, booleans, safe integers, or strings",
  );
}
