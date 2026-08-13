import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("packages/react/package.json", "utf8"));
assert.match(
  packageJson.version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  "package version must be stable SemVer",
);
const expectedTag = `react-v${packageJson.version}`;

assert.equal(
  process.env.RELEASE_TAG,
  expectedTag,
  `release tag must be ${expectedTag}`,
);
