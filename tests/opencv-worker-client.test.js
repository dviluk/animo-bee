import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import {
  OpenCvWorkerClient,
  normalizeWorkerResult,
} from "../src/services/opencv-worker-client.js";

function createConfig(options = {}) {
  const opencvEnabled = options.opencvEnabled ?? false;

  return {
    features: {
      opencvEnabled,
    },
    opencv: {
      workerCommand: options.workerCommand ?? null,
      workerArgs: options.workerArgs ?? [],
      workerUrl: options.workerUrl ?? null,
      timeoutMs: options.timeoutMs ?? 30000,
    },
  };
}

function createClip() {
  return {
    id: 10,
    sourceCamera: "camera_1",
    originalPath: "/tmp/original.mp4",
    currentPath: "/tmp/original.mp4",
    stableAt: new Date().toISOString(),
    checksum: "checksum",
    sizeBytes: 7,
  };
}

test("normalizeWorkerResult validates decision values", () => {
  assert.throws(
    () => normalizeWorkerResult({ decision: "maybe" }),
    /Invalid OpenCV worker decision: maybe/,
  );

  const normalized = normalizeWorkerResult({
    decision: "accepted",
    reason: "ok",
    metadata: { score: 0.9 },
  });

  assert.equal(normalized.decision, "accepted");
  assert.equal(normalized.reason, "ok");
  assert.equal(normalized.metadata.score, 0.9);
});

test("OpenCvWorkerClient returns skipped decision when disabled", async () => {
  const client = new OpenCvWorkerClient(createConfig({ opencvEnabled: false }));
  const result = await client.decideClip(createClip());

  assert.equal(result.decision, "accepted");
  assert.equal(result.reason, "opencv disabled");
  assert.equal(result.metadata.skipped, true);
});

test("OpenCvWorkerClient errors when enabled without worker settings", async () => {
  const client = new OpenCvWorkerClient(createConfig({ opencvEnabled: true }));

  await assert.rejects(
    () => client.decideClip(createClip()),
    /OpenCV is enabled but no worker command or URL is configured/,
  );
});

test("OpenCvWorkerClient uses HTTP worker when configured", async (t) => {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const result = {
        decision: "rejected",
        reason: "threshold",
        metadata: {
          receivedClipId: payload.clipId,
        },
      };

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const workerUrl = `http://127.0.0.1:${address.port}/decision`;
  const client = new OpenCvWorkerClient(
    createConfig({ opencvEnabled: true, workerUrl }),
  );

  t.after(() => {
    server.close();
  });

  const result = await client.decideClip(createClip());

  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "threshold");
  assert.equal(result.metadata.receivedClipId, 10);
});

test("OpenCvWorkerClient propagates HTTP worker failures", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "failed" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const workerUrl = `http://127.0.0.1:${address.port}/decision`;
  const client = new OpenCvWorkerClient(
    createConfig({ opencvEnabled: true, workerUrl }),
  );

  t.after(() => {
    server.close();
  });

  await assert.rejects(
    () => client.decideClip(createClip()),
    /OpenCV worker HTTP 500/,
  );
});

test("OpenCvWorkerClient uses process worker when configured", async () => {
  const script = [
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk.toString(); });",
    "process.stdin.on('end', () => {",
    "  const payload = JSON.parse(raw);",
    "  process.stdout.write(JSON.stringify({ decision: 'accepted', reason: 'process', metadata: { clipId: payload.clipId } }));",
    "});",
  ].join(" ");

  const client = new OpenCvWorkerClient(
    createConfig({
      opencvEnabled: true,
      workerCommand: process.execPath,
      workerArgs: ["-e", script],
    }),
  );

  const result = await client.decideClip(createClip());

  assert.equal(result.decision, "accepted");
  assert.equal(result.reason, "process");
  assert.equal(result.metadata.clipId, 10);
});
