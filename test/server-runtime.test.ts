import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createPulsepondServer } from "../src/index.js";
import { WRITE_KEY } from "./helpers.js";

describe("Node.js server runtime", () => {
  it("delivers through the public factory without adding an Origin", async () => {
    let received:
      | {
          readonly authorization: string | undefined;
          readonly body: string;
          readonly origin: string | undefined;
        }
      | undefined;
    const server = createServer(async (request, response) => {
      received = {
        authorization: request.headers.authorization,
        body: await readBody(request),
        origin: request.headers.origin,
      };
      response.writeHead(202);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      if (address === null || typeof address !== "object") {
        throw new Error("expected a TCP listener");
      }
      const client = createPulsepondServer({
        endpoint: `http://127.0.0.1:${address.port}/v1/batch`,
        environment: "test",
        flushIntervalMs: 0,
        writeKey: WRITE_KEY,
      });
      client.track("app_open", {
        anonymousInstallationId:
          "11111111-1111-4111-8111-111111111111",
        sessionId: "0194f677-6a3d-7c19-8b21-cf30a213c010",
      });

      await client.flush();
      await client.shutdown();

      assert.equal(received?.authorization, `Bearer ${WRITE_KEY}`);
      assert.equal(received?.origin, undefined);
      assert.equal(
        JSON.parse(received?.body ?? "").events[0].platform,
        "server",
      );
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
