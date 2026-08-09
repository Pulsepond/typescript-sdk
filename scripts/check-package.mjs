import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pulsepond-package-"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

try {
  await run("npm", [
    "pack",
    "--pack-destination",
    temporaryDirectory,
    "--ignore-scripts",
  ]);
  const archivePath = join(
    temporaryDirectory,
    `${packageJson.name
      .replace(/^@/, "")
      .replaceAll("/", "-")}-${packageJson.version}.tgz`,
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

  await run("tar", ["-xzf", archivePath, "-C", temporaryDirectory]);
  const publishedModule = await import(
    pathToFileURL(join(temporaryDirectory, "package", "dist", "index.js"))
      .href
  );
  assert.equal(typeof publishedModule.createPulsepond, "function");
  assert.equal(typeof publishedModule.createPulsepondServer, "function");

  assert.equal(packageJson.name, "@pulsepond/typescript-sdk");
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
