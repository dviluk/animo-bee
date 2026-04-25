import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntimeDirectories, loadConfig } from "../src/config/index.js";

const ENV_KEYS = [
  "APP_MODE",
  "HOST",
  "PORT",
  "CAMERA_1_DIR",
  "CAMERA_2_DIR",
  "PROCESSED_DIR",
  "REJECTED_DIR",
  "DB_PATH",
  "LOG_DIR",
  "OPENCV_ENABLED",
];

async function withEnv(overrides, callback) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig resolves the default development paths", async () => {
  await withEnv({}, async () => {
    const config = loadConfig();

    assert.equal(config.mode, "development");
    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.port, 3001);
    assert.deepEqual(config.paths.cameraSources, [
      path.resolve(process.cwd(), "runtime/camera_1"),
      path.resolve(process.cwd(), "runtime/camera_2"),
    ]);
    assert.equal(
      config.paths.dbPath,
      path.resolve(process.cwd(), "runtime/db/orchestrator.sqlite"),
    );
    assert.equal(config.features.opencvEnabled, false);
  });
});

test("loadConfig respects explicit runtime overrides", async () => {
  await withEnv(
    {
      APP_MODE: "production",
      HOST: "127.0.0.1",
      PORT: "4010",
      CAMERA_1_DIR: "/tmp/camera-one",
      CAMERA_2_DIR: "/tmp/camera-two",
      PROCESSED_DIR: "/tmp/processed",
      REJECTED_DIR: "/tmp/rejected",
      DB_PATH: "/tmp/orchestrator.sqlite",
      LOG_DIR: "/tmp/logs",
      OPENCV_ENABLED: "true",
    },
    async () => {
      const config = loadConfig();

      assert.equal(config.mode, "production");
      assert.equal(config.server.host, "127.0.0.1");
      assert.equal(config.server.port, 4010);
      assert.deepEqual(config.paths.cameraSources, [
        "/tmp/camera-one",
        "/tmp/camera-two",
      ]);
      assert.equal(config.paths.processedDir, "/tmp/processed");
      assert.equal(config.paths.rejectedDir, "/tmp/rejected");
      assert.equal(config.paths.dbPath, "/tmp/orchestrator.sqlite");
      assert.equal(config.paths.logDir, "/tmp/logs");
      assert.equal(config.features.opencvEnabled, true);
    },
  );
});

test("loadConfig rejects invalid port values", async () => {
  await withEnv({ PORT: "invalid" }, async () => {
    assert.throws(() => loadConfig(), /Invalid PORT value: invalid/);
  });
});

test("ensureRuntimeDirectories creates the required runtime directories", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-"));
  const config = {
    paths: {
      cameraSources: [
        path.join(runtimeRoot, "camera_1"),
        path.join(runtimeRoot, "camera_2"),
      ],
      processedDir: path.join(runtimeRoot, "processed"),
      rejectedDir: path.join(runtimeRoot, "rejected"),
      dbPath: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      logDir: path.join(runtimeRoot, "logs"),
    },
  };

  await ensureRuntimeDirectories(config);

  const checks = await Promise.all(
    [
      ...config.paths.cameraSources,
      config.paths.processedDir,
      config.paths.rejectedDir,
      config.paths.logDir,
      path.dirname(config.paths.dbPath),
    ].map((directoryPath) => fs.stat(directoryPath)),
  );

  checks.forEach((entry) => assert.equal(entry.isDirectory(), true));
});
