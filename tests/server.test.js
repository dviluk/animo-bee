import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createAppServer } from "../src/index.js";

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
