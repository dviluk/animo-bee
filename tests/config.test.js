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
  "OPENCV_MODE",
  "OPENCV_FAIL_OPEN",
  "OPENCV_RETAIN_REJECTED_FILES",
  "OPENCV_ROI_CONFIG_PATH",
  "OPENCV_MIN_MOTION_DURATION_MS",
  "OPENCV_MAX_BRIGHTNESS_CHANGE",
  "OPENCV_MIN_ROI_MOTION_SCORE",
  "OPENCV_WORKER_COMMAND",
  "OPENCV_WORKER_ARGS",
  "OPENCV_WORKER_URL",
  "OPENCV_TIMEOUT_MS",
  "UPLOAD_ENABLED",
  "UPLOAD_URL",
  "UPLOAD_HEADERS_JSON",
  "UPLOAD_MAX_ATTEMPTS",
  "UPLOAD_POLL_INTERVAL_MS",
  "UPLOAD_RETRY_DELAY_MS",
  "UPLOAD_TIMEOUT_MS",
  "IRRIGATION_ENABLED",
  "IRRIGATION_TRIGGER_URL",
  "IRRIGATION_HEADERS_JSON",
  "IRRIGATION_TIMEOUT_MS",
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
    assert.equal(config.opencv.mode, "disabled");
    assert.equal(config.opencv.failOpen, true);
    assert.equal(config.opencv.retainRejectedFiles, true);
    assert.equal(config.opencv.minMotionDurationMs, 500);
    assert.equal(config.opencv.maxBrightnessChange, 0.25);
    assert.equal(config.opencv.minRoiMotionScore, 0.4);
    assert.equal(config.features.uploadEnabled, false);
    assert.equal(config.features.irrigationEnabled, false);
    assert.equal(config.upload.enabled, false);
    assert.equal(config.upload.url, null);
    assert.deepEqual(config.upload.headers, {});
    assert.equal(config.upload.maxAttempts, 3);
    assert.equal(config.upload.pollIntervalMs, 5000);
    assert.equal(config.upload.retryDelayMs, 30000);
    assert.equal(config.upload.timeoutMs, 60000);
    assert.equal(config.irrigation.enabled, false);
    assert.equal(config.irrigation.triggerUrl, null);
    assert.deepEqual(config.irrigation.headers, {});
    assert.equal(config.irrigation.timeoutMs, 10000);
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
      OPENCV_MODE: "shadow",
      OPENCV_FAIL_OPEN: "false",
      OPENCV_RETAIN_REJECTED_FILES: "false",
      OPENCV_ROI_CONFIG_PATH: "/tmp/opencv-roi.json",
      OPENCV_MIN_MOTION_DURATION_MS: "750",
      OPENCV_MAX_BRIGHTNESS_CHANGE: "0.2",
      OPENCV_MIN_ROI_MOTION_SCORE: "0.6",
      UPLOAD_ENABLED: "true",
      UPLOAD_URL: "https://example.test/upload",
      UPLOAD_HEADERS_JSON: '{"x-api-key":"token"}',
      UPLOAD_MAX_ATTEMPTS: "5",
      UPLOAD_POLL_INTERVAL_MS: "2000",
      UPLOAD_RETRY_DELAY_MS: "15000",
      UPLOAD_TIMEOUT_MS: "45000",
      IRRIGATION_ENABLED: "true",
      IRRIGATION_TRIGGER_URL: "https://example.test/irrigation",
      IRRIGATION_HEADERS_JSON: '{"authorization":"Bearer t"}',
      IRRIGATION_TIMEOUT_MS: "7000",
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
      assert.equal(config.opencv.mode, "shadow");
      assert.equal(config.opencv.failOpen, false);
      assert.equal(config.opencv.retainRejectedFiles, false);
      assert.equal(config.opencv.roiConfigPath, "/tmp/opencv-roi.json");
      assert.equal(config.opencv.minMotionDurationMs, 750);
      assert.equal(config.opencv.maxBrightnessChange, 0.2);
      assert.equal(config.opencv.minRoiMotionScore, 0.6);
      assert.equal(config.features.uploadEnabled, true);
      assert.equal(config.features.irrigationEnabled, true);
      assert.equal(config.upload.enabled, true);
      assert.equal(config.upload.url, "https://example.test/upload");
      assert.deepEqual(config.upload.headers, { "x-api-key": "token" });
      assert.equal(config.upload.maxAttempts, 5);
      assert.equal(config.upload.pollIntervalMs, 2000);
      assert.equal(config.upload.retryDelayMs, 15000);
      assert.equal(config.upload.timeoutMs, 45000);
      assert.equal(config.irrigation.enabled, true);
      assert.equal(
        config.irrigation.triggerUrl,
        "https://example.test/irrigation",
      );
      assert.deepEqual(config.irrigation.headers, {
        authorization: "Bearer t",
      });
      assert.equal(config.irrigation.timeoutMs, 7000);
    },
  );
});

test("loadConfig maps legacy OPENCV_ENABLED=true to shadow mode", async () => {
  await withEnv({ OPENCV_ENABLED: "true" }, async () => {
    const config = loadConfig();

    assert.equal(config.features.opencvEnabled, true);
    assert.equal(config.opencv.enabled, true);
    assert.equal(config.opencv.mode, "shadow");
  });
});

test("loadConfig rejects invalid port values", async () => {
  await withEnv({ PORT: "invalid" }, async () => {
    assert.throws(() => loadConfig(), /Invalid PORT value: invalid/);
  });
});

test("loadConfig rejects invalid OpenCV mode values", async () => {
  await withEnv({ OPENCV_MODE: "invalid" }, async () => {
    assert.throws(() => loadConfig(), /Invalid OPENCV_MODE value: invalid/);
  });
});

test("loadConfig rejects invalid upload headers format", async () => {
  await withEnv({ UPLOAD_HEADERS_JSON: "[]" }, async () => {
    assert.throws(
      () => loadConfig(),
      /UPLOAD_HEADERS_JSON must be a JSON object with string values/,
    );
  });
});

test("loadConfig rejects invalid irrigation headers format", async () => {
  await withEnv({ IRRIGATION_HEADERS_JSON: "[]" }, async () => {
    assert.throws(
      () => loadConfig(),
      /IRRIGATION_HEADERS_JSON must be a JSON object with string values/,
    );
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
