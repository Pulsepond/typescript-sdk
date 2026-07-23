import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pulsepond-package-"));

try {
  await run("corepack", [
    "pnpm",
    "pack",
    "--pack-destination",
    temporaryDirectory,
  ]);
  const archivePath = join(
    temporaryDirectory,
    "pulsepond-typescript-sdk-0.1.0.tgz",
  );
  const files = (await run("tar", ["-tzf", archivePath]))
    .split("\n")
    .filter(Boolean);

  assert.equal(files.some((path) => path.startsWith("package/src/")), false);
  assert.equal(files.some((path) => path.startsWith("package/test/")), false);
  assert.equal(files.includes("package/dist/index.js"), true);
  assert.equal(files.includes("package/dist/index.d.ts"), true);
  assert.equal(files.includes("package/LICENSE"), true);
  assert.equal(files.includes("package/README.md"), true);
  assert.equal(files.includes("package/package.json"), true);

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.name, "@pulsepond/typescript-sdk");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.publishConfig.access, "public");
  assert.equal(packageJson.publishConfig.provenance, true);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
