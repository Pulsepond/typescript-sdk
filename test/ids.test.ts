import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PulsepondConfigurationError } from "../src/errors.js";
import {
  createUuidV7,
  isCanonicalAnonymousId,
} from "../src/ids.js";

describe("UUIDv7", () => {
  it("encodes the timestamp, version, variant, and lowercase syntax", () => {
    const timestamp = 1_700_000_000_000;
    const id = createUuidV7(timestamp, (target) => {
      target.fill(0xff);
    });

    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16),
      timestamp,
    );
    assert.equal(id[14], "7");
    assert.equal(id[19], "b");
    assert.equal(isCanonicalAnonymousId(id), true);
  });

  it("rejects invalid clock values instead of using weak fallback IDs", () => {
    for (const timestamp of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => createUuidV7(timestamp, () => {}),
        PulsepondConfigurationError,
      );
    }
  });

  it("accepts canonical anonymous UUIDv4 and UUIDv7 values only", () => {
    assert.equal(
      isCanonicalAnonymousId(
        "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a10",
      ),
      true,
    );
    assert.equal(
      isCanonicalAnonymousId(
        "550e8400-e29b-41d4-a716-446655440000",
      ),
      true,
    );
    assert.equal(
      isCanonicalAnonymousId(
        "550E8400-E29B-41D4-A716-446655440000",
      ),
      false,
    );
  });
});
