import assert from "node:assert/strict";
import test from "node:test";

import { ConfigManager } from "../src/services/config-manager.js";

function buildConfig(opencvEnabled = false, options = {}) {
  return {
    features: {
      opencvEnabled,
    },
    opencv: {
      enabled: opencvEnabled,
      workerUrl: options.workerUrl ?? null,
      workerCommand: options.workerCommand ?? null,
    },
  };
}

test("getOpenCvEnabled prefers persisted runtime config", () => {
  const config = buildConfig(false);
  const queueManager = {
    getRuntimeConfig: (key) => {
      if (key === "opencv_mode") {
        return "shadow";
      }

      if (key === "opencv_enabled") {
        return true;
      }

      return null;
    },
  };

  const manager = new ConfigManager(config, queueManager);

  assert.equal(manager.getOpenCvEnabled(), true);
});

test("getOpenCvRuntime maps legacy enabled config to shadow mode", () => {
  const manager = new ConfigManager(buildConfig(true), {
    getRuntimeConfig: () => null,
  });

  assert.deepEqual(manager.getOpenCvRuntime(), {
    mode: "shadow",
    enabled: true,
    failOpen: true,
    retainRejectedFiles: true,
    minMotionDurationMs: 500,
    maxBrightnessChange: 0.25,
    minRoiMotionScore: 0.4,
  });
});

test("setOpenCvEnabled persists and updates runtime config state", async () => {
  const config = buildConfig(true);
  const persisted = [];
  const queueManager = {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async (key, value) => {
      persisted.push({ key, value });
    },
  };

  const manager = new ConfigManager(config, queueManager);
  const enabled = await manager.setOpenCvEnabled(false);

  assert.equal(enabled, false);
  assert.equal(persisted.length, 7);
  assert.deepEqual(persisted.slice(0, 2), [
    {
      key: "opencv_mode",
      value: "disabled",
    },
    {
      key: "opencv_enabled",
      value: false,
    },
  ]);
  assert.equal(config.features.opencvEnabled, false);
  assert.equal(config.opencv.enabled, false);
  assert.equal(config.opencv.mode, "disabled");
});

test("setOpenCvRuntime persists mode and threshold overrides", async () => {
  const config = buildConfig(false, {
    workerUrl: "http://127.0.0.1:5002/decision",
  });
  const persisted = [];
  const queueManager = {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async (key, value) => {
      persisted.push({ key, value });
    },
  };

  const manager = new ConfigManager(config, queueManager);
  const runtime = await manager.setOpenCvRuntime({
    mode: "enforce",
    failOpen: false,
    retainRejectedFiles: false,
    minMotionDurationMs: 1200,
    maxBrightnessChange: 0.15,
    minRoiMotionScore: 0.8,
  });

  assert.deepEqual(runtime, {
    mode: "enforce",
    enabled: true,
    failOpen: false,
    retainRejectedFiles: false,
    minMotionDurationMs: 1200,
    maxBrightnessChange: 0.15,
    minRoiMotionScore: 0.8,
  });
  assert.deepEqual(persisted, [
    { key: "opencv_mode", value: "enforce" },
    { key: "opencv_enabled", value: true },
    { key: "opencv_fail_open", value: false },
    { key: "opencv_retain_rejected_files", value: false },
    { key: "opencv_min_motion_duration_ms", value: 1200 },
    { key: "opencv_max_brightness_change", value: 0.15 },
    { key: "opencv_min_roi_motion_score", value: 0.8 },
  ]);
  assert.equal(config.features.opencvEnabled, true);
  assert.equal(config.opencv.mode, "enforce");
  assert.equal(config.opencv.failOpen, false);
});

test("setOpenCvRuntime rejects non-disabled mode without worker contract", async () => {
  const persisted = [];
  const manager = new ConfigManager(buildConfig(false), {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async (key, value) => {
      persisted.push({ key, value });
    },
  });

  await assert.rejects(
    () => manager.setOpenCvRuntime({ mode: "shadow" }),
    /OpenCV mode requires OPENCV_WORKER_URL or OPENCV_WORKER_COMMAND/,
  );

  assert.deepEqual(persisted, []);
});

test("setOpenCvEnabled rejects non-boolean values", async () => {
  const manager = new ConfigManager(buildConfig(false), {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async () => {},
  });

  await assert.rejects(
    () => manager.setOpenCvEnabled("true"),
    /enabled must be boolean/,
  );
});

test("hydrate applies persisted runtime state to config", async () => {
  const config = buildConfig(false);
  const manager = new ConfigManager(config, {
    getRuntimeConfig: (key) => {
      if (key === "opencv_mode") {
        return "shadow";
      }

      if (key === "opencv_enabled") {
        return true;
      }

      if (key === "opencv_fail_open") {
        return false;
      }

      if (key === "opencv_retain_rejected_files") {
        return false;
      }

      if (key === "opencv_min_motion_duration_ms") {
        return 900;
      }

      if (key === "opencv_max_brightness_change") {
        return 0.3;
      }

      if (key === "opencv_min_roi_motion_score") {
        return 0.55;
      }

      return null;
    },
    setRuntimeConfig: async () => {},
  });

  const hydrated = await manager.hydrate();

  assert.deepEqual(hydrated, {
    opencvEnabled: true,
    opencv: {
      mode: "shadow",
      enabled: true,
      failOpen: false,
      retainRejectedFiles: false,
      minMotionDurationMs: 900,
      maxBrightnessChange: 0.3,
      minRoiMotionScore: 0.55,
    },
  });
  assert.equal(config.features.opencvEnabled, true);
  assert.equal(config.opencv.enabled, true);
  assert.equal(config.opencv.mode, "shadow");
  assert.equal(config.opencv.failOpen, false);
});
