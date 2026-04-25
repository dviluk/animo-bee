import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLIP_DETECTED_EVENT,
  ClipWatcher,
  createClipDetectedEvent,
  shouldIgnoreClipFile,
  waitForStableFile,
} from "../src/services/file-watcher.js";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const intervalMs = options.intervalMs ?? 25;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(options.message ?? "Condition was not met before timeout.");
}

async function createCameraConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-watcher-"));
  const camera1 = path.join(root, "camera_1");
  const camera2 = path.join(root, "camera_2");

  await fs.mkdir(camera1, { recursive: true });
  await fs.mkdir(camera2, { recursive: true });

  return {
    root,
    config: {
      paths: {
        cameraSources: [camera1, camera2],
      },
    },
    camera1,
    camera2,
  };
}

test("shouldIgnoreClipFile filters hidden and temporary files", () => {
  assert.equal(shouldIgnoreClipFile("/tmp/.dotfile"), true);
  assert.equal(shouldIgnoreClipFile("/tmp/video.tmp"), true);
  assert.equal(shouldIgnoreClipFile("/tmp/video.part"), true);
  assert.equal(shouldIgnoreClipFile("/tmp/video.mp4"), false);
});

test("waitForStableFile returns stats for stable non-empty files", async () => {
  const filePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-stable-")),
    "clip.mp4",
  );

  await fs.writeFile(filePath, "abc");

  const stats = await waitForStableFile(filePath, {
    attempts: 4,
    delayMs: 10,
  });

  assert.equal(stats.size, 3);
});

test("waitForStableFile rejects empty files", async () => {
  const filePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-empty-")),
    "clip.mp4",
  );

  await fs.writeFile(filePath, "");

  await assert.rejects(
    () =>
      waitForStableFile(filePath, {
        attempts: 3,
        delayMs: 10,
      }),
    /File is empty/,
  );
});

test("createClipDetectedEvent resolves camera source and payload shape", async () => {
  const { camera1, camera2 } = await createCameraConfig();
  const clipPath = path.join(camera2, "sample.mp4");

  await fs.writeFile(clipPath, "payload");
  const stats = await fs.stat(clipPath);
  const event = createClipDetectedEvent(clipPath, stats, [camera1, camera2]);

  assert.equal(event.type, CLIP_DETECTED_EVENT);
  assert.equal(event.sourceCamera, "camera_2");
  assert.equal(event.originalPath, path.resolve(clipPath));
  assert.equal(event.sizeBytes, stats.size);
  assert.equal(typeof event.stableAt, "string");
});

test("ClipWatcher emits one event per stable file and dedupes repeated changes", async (t) => {
  const { config, camera1 } = await createCameraConfig();
  const events = [];
  const errors = [];
  const watcher = new ClipWatcher(config, {
    onClipDetected: async (event) => {
      events.push(event);
    },
    onError: (error) => {
      errors.push(error);
    },
    stability: {
      attempts: 10,
      delayMs: 20,
    },
  });

  await watcher.start();

  t.after(async () => {
    await watcher.stop();
  });

  const filePath = path.join(camera1, "clip-a.mp4");

  await fs.writeFile(filePath, "a");
  await delay(30);
  await fs.appendFile(filePath, "b");

  await waitForCondition(() => events.length === 1, {
    timeoutMs: 3000,
    message: "Expected one watcher event for stable clip.",
  });

  assert.equal(events[0].type, CLIP_DETECTED_EVENT);
  assert.equal(events[0].sourceCamera, "camera_1");
  assert.equal(events[0].originalPath, path.resolve(filePath));

  await fs.appendFile(filePath, "c");
  await delay(200);

  assert.equal(events.length, 1);
  assert.equal(errors.length, 0);
});

test("ClipWatcher ignores temp files and retries zero-byte files on later change", async (t) => {
  const { config, camera1 } = await createCameraConfig();
  const events = [];
  const errors = [];
  const watcher = new ClipWatcher(config, {
    onClipDetected: async (event) => {
      events.push(event);
    },
    onError: (error) => {
      errors.push(error);
    },
    stability: {
      attempts: 5,
      delayMs: 15,
    },
  });

  await watcher.start();

  t.after(async () => {
    await watcher.stop();
  });

  const ignoredTempFile = path.join(camera1, "ignored.tmp");
  await fs.writeFile(ignoredTempFile, "temp");
  await delay(200);

  assert.equal(events.length, 0);

  const emptyFile = path.join(camera1, "clip-empty.mp4");
  await fs.writeFile(emptyFile, "");

  await waitForCondition(
    () => errors.some((error) => /File is empty/.test(error.message)),
    {
      timeoutMs: 3000,
      message: "Expected zero-byte error from watcher.",
    },
  );

  await fs.writeFile(emptyFile, "payload");

  await waitForCondition(
    () => events.some((event) => event.originalPath === path.resolve(emptyFile)),
    {
      timeoutMs: 3000,
      message: "Expected watcher to emit event after file gained content.",
    },
  );
});
