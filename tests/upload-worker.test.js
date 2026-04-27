import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UploadWorker } from "../src/services/upload-worker.js";

function buildConfig(overrides = {}) {
  const {
    upload: uploadOverrides = {},
    paths: pathOverrides = {},
    ...rest
  } = overrides;

  return {
    paths: {
      processedDir: "/tmp/processed",
      ...pathOverrides,
    },
    upload: {
      enabled: true,
      url: "https://example.test/upload",
      headers: {},
      maxAttempts: 3,
      pollIntervalMs: 50,
      retryDelayMs: 100,
      timeoutMs: 1000,
      ...uploadOverrides,
    },
    ...rest,
  };
}

test("runOnce returns disabled when upload worker is not configured", async () => {
  const worker = new UploadWorker(
    buildConfig({
      upload: {
        enabled: false,
        url: null,
      },
    }),
    {},
  );

  const result = await worker.runOnce();

  assert.deepEqual(result, { status: "disabled" });
  assert.equal(worker.getStatus().configured, false);
});

test("runOnce uploads a queued clip and records the attempt", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-up-"));
  const clipPath = path.join(runtimeRoot, "clip-upload.mp4");

  await fs.writeFile(clipPath, "upload-payload", "utf8");

  t.after(async () => {
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  });

  const attempts = [];
  let fetchCall = null;

  const queueManager = {
    getNextQueuedClip: () => ({
      id: 11,
      currentPath: clipPath,
      sourceCamera: "camera_1",
      checksum: "checksum-11",
      opencvMode: "shadow",
      opencvStatus: "completed",
      opencvDecision: "accept",
      opencvReason: "roi_motion",
      opencvScores: { roi_motion_score: 0.88 },
    }),
    getUploadAttemptCount: () => 0,
    markUploading: async (clipId) => ({
      id: clipId,
      currentPath: clipPath,
      sourceCamera: "camera_1",
      checksum: "checksum-11",
      opencvMode: "shadow",
      opencvStatus: "completed",
      opencvDecision: "accept",
      opencvReason: "roi_motion",
      opencvScores: { roi_motion_score: 0.88 },
      status: "uploading",
    }),
    recordUploadAttempt: async (_clipId, attempt) => {
      attempts.push(attempt);
    },
    completeUpload: async (clipId) => ({
      id: clipId,
      status: "uploaded",
      currentPath: path.join(runtimeRoot, "processed", "clip-upload.mp4"),
    }),
  };

  const worker = new UploadWorker(
    buildConfig({
      upload: {
        headers: { authorization: "Bearer test" },
        externalSourceKey: "edge-cam-01",
        deviceId: "bee-pi-01",
      },
      paths: {
        processedDir: path.join(runtimeRoot, "processed"),
      },
    }),
    queueManager,
    {
      fetch: async (url, options) => {
        fetchCall = { url, options };
        return {
          ok: true,
          status: 201,
        };
      },
    },
  );

  const result = await worker.runOnce();

  assert.equal(result.status, "uploaded");
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.responseStatus, 201);
  assert.equal(fetchCall.url, "https://example.test/upload");
  assert.equal(fetchCall.options.method, "POST");
  assert.equal(fetchCall.options.headers.authorization, "Bearer test");
  assert.equal(fetchCall.options.headers["x-animo-clip-id"], "11");
  assert.equal(fetchCall.options.headers["x-animo-source-camera"], "camera_1");
  assert.equal(fetchCall.options.headers["x-animo-checksum"], "checksum-11");
  assert.equal(
    fetchCall.options.headers["Idempotency-Key"],
    "edge-cam-01:11:checksum-11",
  );
  assert.equal(
    fetchCall.options.headers["x-animo-original-filename"],
    "clip-upload.mp4",
  );
  assert.equal(
    fetchCall.options.body.get("check_type"),
    "pollination_activity",
  );
  assert.equal(fetchCall.options.body.get("domain_profile"), "pollination");
  assert.equal(fetchCall.options.body.get("media_kind"), "video");
  assert.equal(fetchCall.options.body.get("source_channel"), "edge_device");
  assert.equal(
    fetchCall.options.body.get("processing_mode"),
    "edge_prefiltered",
  );
  assert.equal(fetchCall.options.body.get("backend_processing"), "required");
  assert.equal(fetchCall.options.body.get("device_id"), "bee-pi-01");
  assert.equal(fetchCall.options.body.get("camera_id"), "camera_1");
  assert.equal(
    fetchCall.options.body.get("external_source_key"),
    "edge-cam-01",
  );
  assert.equal(fetchCall.options.body.get("source_clip_id"), "camera_1:11");
  assert.equal(
    fetchCall.options.body.get("idempotency_key"),
    "edge-cam-01:11:checksum-11",
  );
  assert.equal(
    fetchCall.options.body.get("metadata[edge_prefilter][clip_id]"),
    "11",
  );
  assert.equal(
    fetchCall.options.body.get("metadata[edge_prefilter][opencv_mode]"),
    "shadow",
  );
  assert.equal(
    fetchCall.options.body.get("metadata[edge_upload][attempt_number]"),
    "1",
  );
  const uploadedFile = fetchCall.options.body.get("file");
  assert.equal(uploadedFile.name, "clip-upload.mp4");
  assert.equal(uploadedFile.type, "video/mp4");
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0], {
    attemptNumber: 1,
    responseStatus: 201,
  });
});

test("runOnce requeues clip when upload fails before max attempts", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-up-"));
  const clipPath = path.join(runtimeRoot, "clip-retry.mp4");

  await fs.writeFile(clipPath, "retry", "utf8");

  t.after(async () => {
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  });

  const attempts = [];
  let requeueError = null;

  const queueManager = {
    getNextQueuedClip: () => ({
      id: 22,
      currentPath: clipPath,
      sourceCamera: "camera_2",
      checksum: "checksum-22",
    }),
    getUploadAttemptCount: () => 0,
    markUploading: async () => ({
      id: 22,
      currentPath: clipPath,
      sourceCamera: "camera_2",
      checksum: "checksum-22",
      status: "uploading",
    }),
    recordUploadAttempt: async (_clipId, attempt) => {
      attempts.push(attempt);
    },
    requeueUpload: async (_clipId, error) => {
      requeueError = error;
      return {
        id: 22,
        status: "queued",
      };
    },
  };

  const worker = new UploadWorker(
    buildConfig({
      upload: {
        maxAttempts: 2,
        retryDelayMs: 222,
      },
    }),
    queueManager,
    {
      fetch: async () => ({
        ok: false,
        status: 500,
      }),
    },
  );

  const result = await worker.runOnce();

  assert.equal(result.status, "queued_for_retry");
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.retryAfterMs, 222);
  assert.equal(result.clip.status, "queued");
  assert.equal(requeueError.message, "Upload failed with HTTP 500");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[0].responseStatus, 500);
  assert.match(attempts[0].errorSummary, /Upload failed with HTTP 500/);
});

test("uploadClip uses raw processing mode when opencv is disabled", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-up-"));
  const clipPath = path.join(runtimeRoot, "clip-raw-mode.mp4");

  await fs.writeFile(clipPath, "raw-mode", "utf8");

  t.after(async () => {
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  });

  let fetchCall = null;

  const worker = new UploadWorker(
    buildConfig({
      upload: {
        externalSourceKey: "edge-cam-02",
      },
    }),
    {},
    {
      fetch: async (_url, options) => {
        fetchCall = options;
        return {
          ok: true,
          status: 204,
        };
      },
    },
  );

  const uploadResult = await worker.uploadClip(
    {
      id: 55,
      currentPath: clipPath,
      sourceCamera: "camera_3",
      checksum: "checksum-55",
      opencvMode: "disabled",
      opencvStatus: "skipped",
      opencvDecision: "accept",
      opencvReason: "opencv_disabled",
      opencvScores: {},
    },
    1,
  );

  assert.equal(uploadResult.responseStatus, 204);
  assert.equal(fetchCall.body.get("processing_mode"), "raw");
  assert.equal(fetchCall.body.get("backend_processing"), "required");
});

test("processClip marks clip exhausted when max attempts are already reached", async () => {
  let failClipInput = null;
  let fetchCalled = false;

  const queueManager = {
    getUploadAttemptCount: () => 3,
    failClip: async (clipId, reason) => {
      failClipInput = { clipId, reason };
      return {
        id: clipId,
        status: "failed",
      };
    },
  };

  const worker = new UploadWorker(
    buildConfig({
      upload: {
        maxAttempts: 3,
      },
    }),
    queueManager,
    {
      fetch: async () => {
        fetchCalled = true;
        return { ok: true, status: 200 };
      },
    },
  );

  const result = await worker.processClip({ id: 33 });

  assert.equal(result.status, "exhausted");
  assert.equal(result.clip.status, "failed");
  assert.deepEqual(failClipInput, {
    clipId: 33,
    reason: "Upload attempts exhausted after 3 attempts",
  });
  assert.equal(fetchCalled, false);
});

test("processClip honors manual retry budget resets", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-up-"));
  const clipPath = path.join(runtimeRoot, "clip-manual-retry.mp4");

  await fs.writeFile(clipPath, "retry-window", "utf8");

  t.after(async () => {
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  });

  const attempts = [];
  let fetchCalled = false;

  const queueManager = {
    getUploadAttemptBudgetCount: () => 0,
    getUploadAttemptCount: () => 3,
    markUploading: async (clipId) => ({
      id: clipId,
      currentPath: clipPath,
      sourceCamera: "camera_1",
      checksum: "checksum-44",
      status: "uploading",
    }),
    recordUploadAttempt: async (_clipId, attempt) => {
      attempts.push(attempt);
    },
    completeUpload: async (clipId) => ({
      id: clipId,
      status: "uploaded",
      currentPath: path.join(runtimeRoot, "processed", "clip-manual-retry.mp4"),
    }),
  };

  const worker = new UploadWorker(buildConfig(), queueManager, {
    fetch: async () => {
      fetchCalled = true;
      return {
        ok: true,
        status: 202,
      };
    },
  });

  const result = await worker.processClip({
    id: 44,
    currentPath: clipPath,
    sourceCamera: "camera_1",
    checksum: "checksum-44",
  });

  assert.equal(fetchCalled, true);
  assert.equal(result.status, "uploaded");
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.responseStatus, 202);
  assert.deepEqual(attempts, [
    {
      attemptNumber: 1,
      responseStatus: 202,
    },
  ]);
});
