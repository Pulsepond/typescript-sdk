import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join, normalize } from "node:path";
import { describe, it } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { WRITE_KEY } from "./helpers.js";

interface CapturedRequest {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly url: string;
}

describe("real browser contract", () => {
  it("uses exact CORS headers, omits ambient data, and flushes on pagehide", async () => {
    const captured: CapturedRequest[] = [];
    let allowedOrigin = "";
    const collector = createServer(async (request, response) => {
      const body = await readBody(request);
      captured.push({
        body,
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      });
      response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "POST");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        response.writeHead(204);
      } else {
        response.writeHead(202);
      }
      response.end();
    });
    const application = createServer(async (request, response) => {
      const path = request.url === "/" ? "/index.html" : request.url ?? "";
      if (path === "/index.html") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end("<!doctype html><title>Pulsepond browser test</title>");
        return;
      }
      if (!path.startsWith("/sdk/")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const relative = normalize(path.slice("/sdk/".length));
      if (
        relative.startsWith("..") ||
        relative.includes("\0") ||
        !relative.endsWith(".js")
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const source = await readFile(join(process.cwd(), "dist", relative));
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(source);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    let applicationOrigin = "";
    let browser: Browser | undefined;

    try {
      const collectorOrigin = await listen(collector);
      applicationOrigin = await listen(application);
      allowedOrigin = applicationOrigin;
      const executablePath = await findBrowserExecutable();
      browser = await chromium.launch({
        executablePath,
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(applicationOrigin);
      const result = await page.evaluate(
        async ({ endpoint, writeKey }) => {
          document.cookie = "ambient_cookie=must_not_leave_origin";
          const beforeImport = localStorage.length;
          const sdkPath = "/sdk/index.js";
          const sdk = (await import(sdkPath)) as {
            createPulsepond(config: {
              endpoint: string;
              environment: string;
              flushIntervalMs: number;
              writeKey: string;
            }): {
              flush(): Promise<void>;
              track(
                name: string,
                properties?: Readonly<Record<string, string>>,
              ): string | null;
            };
          };
          const afterImport = localStorage.length;
          const client = sdk.createPulsepond({
            endpoint,
            environment: "browser_test",
            flushIntervalMs: 0,
            writeKey,
          });
          const eventId = client.track("browser_flush", {
            work_id: "work_123",
          });
          await client.flush();
          const afterFlush = localStorage.length;
          client.track("pagehide_flush");
          window.dispatchEvent(new Event("pagehide"));
          await new Promise((resolve) => {
            window.setTimeout(resolve, 100);
          });
          return {
            afterFlush,
            afterImport,
            beforeImport,
            eventId,
          };
        },
        {
          endpoint: `${collectorOrigin}/v1/batch`,
          writeKey: WRITE_KEY,
        },
      );

      assert.equal(result.beforeImport, 0);
      assert.equal(result.afterImport, 0);
      assert.equal(result.afterFlush, 0);
      assert.match(result.eventId ?? "", /^[0-9a-f-]{36}$/);
    } finally {
      await Promise.allSettled([
        browser?.close() ?? Promise.resolve(),
        closeIfListening(application),
        closeIfListening(collector),
      ]);
    }

    const preflight = captured.find(
      ({ method, url }) => method === "OPTIONS" && url === "/v1/batch",
    );
    assert.ok(preflight);
    assert.deepEqual(
      new Set(
        preflight.headers["access-control-request-headers"]
          ?.split(",")
          .map((name) => name.trim().toLowerCase()),
      ),
      new Set(["authorization", "content-type"]),
    );

    const posts = captured.filter(
      ({ method, url }) => method === "POST" && url === "/v1/batch",
    );
    assert.equal(posts.length, 2);
    for (const request of posts) {
      assert.equal(request.headers.authorization, `Bearer ${WRITE_KEY}`);
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.referer, undefined);
      assert.equal(request.headers.origin, applicationOrigin);
      assert.equal("x-pulsepond-sdk" in request.headers, false);
    }
    assert.equal(
      JSON.parse(posts[1]!.body).events[0].event_name,
      "pagehide_flush",
    );
  });
});

async function findBrowserExecutable(): Promise<string> {
  const candidates = [
    process.env.PULSEPOND_CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known system browser path.
    }
  }
  throw new Error(
    "No system Chrome/Chromium found; set PULSEPOND_CHROME_PATH",
  );
}

function listen(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not expose a TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function closeIfListening(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  return server.listening ? close(server) : Promise.resolve();
}

async function readBody(
  request: AsyncIterable<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
