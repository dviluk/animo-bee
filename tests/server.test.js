import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createAppServer, startServer, stopServer } from "../src/index.js";

function buildConfig() {
  return {
    mode: "development",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
    features: {
      opencvEnabled: false,
    },
    paths: {
      cameraSources: ["/tmp/camera_1", "/tmp/camera_2"],
      processedDir: "/tmp/processed",
      rejectedDir: "/tmp/rejected",
      dbPath: "/tmp/orchestrator.sqlite",
      logDir: "/tmp/logs",
    },
  };
}

async function startTestServer(services = {}) {
  const server = createAppServer(buildConfig(), services);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("GET /health returns the runtime summary", async (t) => {
  const { server, baseUrl } = await startTestServer();

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    data: {
      status: "ok",
      service: "animo-bee",
      mode: "development",
      host: "127.0.0.1",
      port: 0,
      opencvEnabled: false,
      paths: {
        cameraSources: ["/tmp/camera_1", "/tmp/camera_2"],
        processedDir: "/tmp/processed",
        rejectedDir: "/tmp/rejected",
      },
    },
  });
});

test("GET /health includes queue and worker statuses when services are attached", async (t) => {
  const { server, baseUrl } = await startTestServer({
    queueManager: {
      getQueueSummary: () => ({ total: 3 }),
    },
    uploadWorker: {
      getStatus: () => ({ running: true }),
    },
    irrigationController: {
      getStatus: () => ({ enabled: true }),
    },
  });

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.queue, { total: 3 });
  assert.deepEqual(payload.data.upload, { running: true });
  assert.deepEqual(payload.data.irrigation, { enabled: true });
});

test("GET / returns the scaffold status message", async (t) => {
  const { server, baseUrl } = await startTestServer();

  t.after(() => server.close());

  const response = await fetch(baseUrl);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    data: {
      message: "animo-bee scaffold is running",
    },
  });
});

test("unknown routes return 404 JSON", async (t) => {
  const { server, baseUrl } = await startTestServer();

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/missing`);
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(payload, {
    error: "Not Found",
  });
});

test("GET /queue returns queue summary and clips", async (t) => {
  let capturedOptions = null;
  const queueManager = {
    getQueueSummary: () => ({ total: 2, failed: 1 }),
    listClips: (options) => {
      capturedOptions = options;
      return [{ id: 7, status: "failed" }];
    },
  };

  const { server, baseUrl } = await startTestServer({ queueManager });

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/queue?status=failed&limit=3`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(capturedOptions, { status: "failed", limit: 3 });
  assert.deepEqual(payload, {
    data: {
      summary: { total: 2, failed: 1 },
      clips: [{ id: 7, status: "failed" }],
    },
  });
});

test("GET /queue returns 503 when queue manager is unavailable", async (t) => {
  const { server, baseUrl } = await startTestServer();

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/queue`);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    error: "Queue manager is not available.",
  });
});

test("GET /queue/:clipId returns clip details and upload attempts", async (t) => {
  const queueManager = {
    getClipById: (clipId) =>
      clipId === 7 ? { id: 7, status: "failed" } : null,
    listUploadAttempts: () => [
      { attemptNumber: 1, responseStatus: 500, errorSummary: "boom" },
    ],
  };

  const { server, baseUrl } = await startTestServer({ queueManager });

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/queue/7`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    data: {
      clip: { id: 7, status: "failed" },
      uploadAttempts: [
        { attemptNumber: 1, responseStatus: 500, errorSummary: "boom" },
      ],
    },
  });
});

test("POST /config/opencv toggles OpenCV runtime state", async (t) => {
  let savedValue = null;
  const opencvWorkerClient = { enabled: false };
  const configManager = {
    setOpenCvEnabled: async (value) => {
      savedValue = value;
      return value;
    },
  };

  const { server, baseUrl } = await startTestServer({
    configManager,
    opencvWorkerClient,
  });

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/config/opencv`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ enabled: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(savedValue, true);
  assert.equal(opencvWorkerClient.enabled, true);
  assert.deepEqual(payload, {
    data: {
      opencvEnabled: true,
    },
  });
});

test("POST /uploads/retry/:clipId retries a failed upload and wakes the worker", async (t) => {
  let wokeWorker = false;
  const queueManager = {
    retryFailedUpload: async (clipId) => ({ id: clipId, status: "queued" }),
  };
  const uploadWorker = {
    wake: async () => {
      wokeWorker = true;
    },
  };

  const { server, baseUrl } = await startTestServer({
    queueManager,
    uploadWorker,
  });

  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/uploads/retry/42`, {
    method: "POST",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(wokeWorker, true);
  assert.deepEqual(payload, {
    data: {
      clip: { id: 42, status: "queued" },
    },
  });
});

test("POST /irrigation/trigger validates action and maps failures to 502", async (t) => {
  const irrigationController = {
    trigger: async () => ({
      ok: false,
      responseStatus: 504,
      error: "upstream timeout",
    }),
  };

  const { server, baseUrl } = await startTestServer({ irrigationController });

  t.after(() => server.close());

  const invalidResponse = await fetch(`${baseUrl}/irrigation/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: " " }),
  });
  const invalidPayload = await invalidResponse.json();

  assert.equal(invalidResponse.status, 422);
  assert.deepEqual(invalidPayload, {
    error: "action must be a non-empty string.",
  });

  const response = await fetch(`${baseUrl}/irrigation/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "open" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(payload, {
    data: {
      ok: false,
      responseStatus: 504,
      error: "upstream timeout",
    },
  });
});

test("startServer supports disabling the file watcher", async (t) => {
  const config = buildConfig();
  config.server.port = 0;

  const server = await startServer(config, { startWatcher: false });

  t.after(async () => {
    await stopServer(server);
  });

  assert.equal(server.listening, true);
  assert.equal(server.clipWatcher, undefined);
});

test("startServer exposes recovered clips when queue recovery runs", async (t) => {
  const config = buildConfig();
  config.server.port = 0;

  const recoveredClips = [{ id: 99, status: "queued" }];
  const queueManager = {
    recoverPendingWork: async () => recoveredClips,
    close: async () => {},
  };

  let callbackPayload = null;

  const server = await startServer(config, {
    startWatcher: false,
    queueManager,
    onRecoveredClips: async (clips) => {
      callbackPayload = clips;
    },
  });

  t.after(async () => {
    await stopServer(server);
  });

  assert.deepEqual(server.resumableClips, recoveredClips);
  assert.deepEqual(callbackPayload, recoveredClips);
});

test("startServer starts and stopServer stops the upload worker", async () => {
  const config = buildConfig();
  config.server.port = 0;

  let started = false;
  let stopped = false;

  const uploadWorker = {
    start: () => {
      started = true;
    },
    stop: async () => {
      stopped = true;
    },
  };

  const queueManager = {
    recoverPendingWork: async () => [],
    getNextQueuedClip: () => null,
    markUploading: async () => null,
    completeUpload: async () => null,
    close: async () => {},
  };

  const server = await startServer(config, {
    startWatcher: false,
    queueManager,
    uploadWorker,
  });

  assert.equal(started, true);

  await stopServer(server);

  assert.equal(stopped, true);
});

test("stopServer closes both http server and attached clip watcher", async () => {
  const server = createAppServer(buildConfig());
  let watcherStopped = false;

  server.clipWatcher = {
    stop: async () => {
      watcherStopped = true;
    },
  };

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  await stopServer(server);

  assert.equal(watcherStopped, true);
  assert.equal(server.listening, false);
});
