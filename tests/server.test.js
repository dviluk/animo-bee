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

async function startTestServer() {
  const server = createAppServer(buildConfig());

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
