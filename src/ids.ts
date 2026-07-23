import { PulsepondConfigurationError } from "./errors.js";

const UUID_V4_OR_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;

export function createUuidV7(
  timestampMs: number,
  randomBytes: (target: Uint8Array) => void,
): string {
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > MAX_UUID_V7_TIMESTAMP
  ) {
    throw new PulsepondConfigurationError(
      "Pulsepond received an invalid system clock value",
    );
  }

  const bytes = new Uint8Array(16);
  randomBytes(bytes);

  let remainingTimestamp = timestampMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }

  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function isCanonicalAnonymousId(value: string): boolean {
  return UUID_V4_OR_V7.test(value);
}
