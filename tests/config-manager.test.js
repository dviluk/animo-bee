import assert from "node:assert/strict";
import test from "node:test";

import { ConfigManager } from "../src/services/config-manager.js";

function buildConfig(opencvEnabled = false) {
  return {
    features: {
      opencvEnabled,
    },
    opencv: {
      enabled: opencvEnabled,
    },
  };
}

test("getOpenCvEnabled prefers persisted runtime config", () => {
  const config = buildConfig(false);
  const queueManager = {
    getRuntimeConfig: () => true,
  };

  const manager = new ConfigManager(config, queueManager);

  assert.equal(manager.getOpenCvEnabled(), true);
});

test("setOpenCvEnabled persists and updates runtime config state", async () => {
  const config = buildConfig(true);
  let persisted = null;
  const queueManager = {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async (key, value) => {
      persisted = { key, value };
    },
  };

  const manager = new ConfigManager(config, queueManager);
  const enabled = await manager.setOpenCvEnabled(false);

  assert.equal(enabled, false);
  assert.deepEqual(persisted, {
    key: "opencv_enabled",
    value: false,
  });
  assert.equal(config.features.opencvEnabled, false);
  assert.equal(config.opencv.enabled, false);
});

test("setOpenCvEnabled rejects non-boolean values", async () => {
  const manager = new ConfigManager(buildConfig(false), {
    getRuntimeConfig: () => null,
    setRuntimeConfig: async () => {},
  });

  await assert.rejects(
    () => manager.setOpenCvEnabled("true"),
    /Expected boolean value/,
  );
});

test("hydrate applies persisted runtime state to config", async () => {
  const config = buildConfig(false);
  const manager = new ConfigManager(config, {
    getRuntimeConfig: () => true,
    setRuntimeConfig: async () => {},
  });

  const hydrated = await manager.hydrate();

  assert.deepEqual(hydrated, {
    opencvEnabled: true,
  });
  assert.equal(config.features.opencvEnabled, true);
  assert.equal(config.opencv.enabled, true);
});
