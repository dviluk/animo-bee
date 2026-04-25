import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClipDetectedEvent } from "../src/services/file-watcher.js";
import {
  assertClipTransition,
  createQueueManager,
} from "../src/services/queue-manager.js";

async function createRuntimeConfig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-queue-"));
  const camera1 = path.join(root, "camera_1");
  const camera2 = path.join(root, "camera_2");
  const rejectedDir = path.join(root, "rejected");
  const dbPath = path.join(root, "db", "orchestrator.sqlite");

  await fs.mkdir(camera1, { recursive: true });
  await fs.mkdir(camera2, { recursive: true });

  return {
    root,
    camera1,
    camera2,
    rejectedDir,
    config: {
      paths: {
        cameraSources: [camera1, camera2],
        rejectedDir,
        dbPath,
      },
    },
  };
}

async function createClipEvent(cameraDir, clipName, payload = "payload") {
  const clipPath = path.join(cameraDir, clipName);

  await fs.writeFile(clipPath, payload);

  const stats = await fs.stat(clipPath);

  return {
    clipPath,
    event: createClipDetectedEvent(clipPath, stats, [cameraDir]),
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

test("QueueManager initializes required SQLite tables", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const tableNames = queueManager
    .getRows("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name);

  ["clips", "upload_attempts", "runtime_config", "irrigation_events"].forEach(
    (tableName) => {
      assert.equal(tableNames.includes(tableName), true);
    },
  );
});

test("QueueManager enqueues once per original path and stable timestamp", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const { event } = await createClipEvent(runtime.camera1, "clip-a.mp4", "abc");

  const firstInsert = await queueManager.enqueueClip(event, {
    checksum: "checksum-a",
    opencvEnabled: true,
  });
  const secondInsert = await queueManager.enqueueClip(event, {
    checksum: "checksum-a",
    opencvEnabled: true,
  });
  const replayEvent = {
    ...event,
    stableAt: new Date(Date.parse(event.stableAt) + 1000).toISOString(),
  };
  const thirdInsert = await queueManager.enqueueClip(replayEvent, {
    checksum: "checksum-b",
    opencvEnabled: true,
  });

  assert.equal(firstInsert.created, true);
  assert.equal(secondInsert.created, false);
  assert.equal(thirdInsert.created, true);
  assert.equal(firstInsert.clip.id, secondInsert.clip.id);
  assert.notEqual(firstInsert.clip.id, thirdInsert.clip.id);
  assert.equal(firstInsert.clip.status, "ready");
  assert.equal(firstInsert.clip.opencvEnabled, true);

  const rowCount = queueManager.getRows(
    "SELECT COUNT(*) AS total FROM clips",
  )[0].total;

  assert.equal(rowCount, 2);
});

test("assertClipTransition rejects illegal transitions", () => {
  assert.throws(
    () => assertClipTransition("uploaded", "queued"),
    /Cannot transition clip from uploaded to queued/,
  );

  assert.throws(
    () => assertClipTransition("ready", "not-a-state"),
    /Unknown clip status: not-a-state/,
  );
});

test("recoverPendingWork resets processing and uploading states", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const clipA = await createClipEvent(
    runtime.camera1,
    "clip-processing.mp4",
    "aaaa",
  );
  const clipB = await createClipEvent(
    runtime.camera2,
    "clip-uploading.mp4",
    "bbbb",
  );

  const { clip: processingClip } = await queueManager.enqueueClip(clipA.event, {
    checksum: "processing",
    opencvEnabled: false,
  });
  const { clip: uploadingClip } = await queueManager.enqueueClip(clipB.event, {
    checksum: "uploading",
    opencvEnabled: false,
  });

  await queueManager.markProcessing(processingClip.id);
  const queuedClip = await queueManager.acceptClip(uploadingClip.id, {
    decision: "accepted",
    reason: "queue",
  });
  assert.equal(queuedClip.status, "queued");
  await queueManager.transitionClip(uploadingClip.id, "uploading");

  const resumable = await queueManager.recoverPendingWork();
  const recoveredProcessing = queueManager.getClipById(processingClip.id);
  const recoveredUploading = queueManager.getClipById(uploadingClip.id);

  assert.equal(recoveredProcessing.status, "ready");
  assert.equal(recoveredUploading.status, "queued");
  assert.equal(
    resumable.some((clip) => clip.id === processingClip.id),
    true,
  );
  assert.equal(
    resumable.some((clip) => clip.id === uploadingClip.id),
    true,
  );
});

test("rejectClip routes the file and records rejection metadata", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const { clipPath, event } = await createClipEvent(
    runtime.camera1,
    "clip-reject.mp4",
    "reject-me",
  );

  const { clip } = await queueManager.enqueueClip(event, {
    checksum: "reject",
    opencvEnabled: true,
  });

  await queueManager.markProcessing(clip.id);

  const rejectedClip = await queueManager.rejectClip(
    clip.id,
    {
      decision: "rejected",
      reason: "low confidence",
      metadata: { score: 0.18 },
    },
    runtime.rejectedDir,
  );

  assert.equal(rejectedClip.status, "rejected");
  assert.equal(rejectedClip.decision, "rejected");
  assert.equal(rejectedClip.decisionReason, "low confidence");
  assert.equal(rejectedClip.metadata.score, 0.18);
  assert.equal(
    rejectedClip.currentPath.startsWith(path.resolve(runtime.rejectedDir)),
    true,
  );
  assert.equal(await pathExists(clipPath), false);
  assert.equal(await pathExists(rejectedClip.currentPath), true);
});

test("completeUpload moves file to processed directory and marks uploaded", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);
  const processedDir = path.join(runtime.root, "processed");

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const { clipPath, event } = await createClipEvent(
    runtime.camera1,
    "clip-upload-success.mp4",
    "uploadable",
  );

  const { clip } = await queueManager.enqueueClip(event, {
    checksum: "upload-success",
    opencvEnabled: false,
  });

  const queuedClip = await queueManager.acceptClip(clip.id, {
    decision: "accepted",
    reason: "queued",
  });
  await queueManager.markUploading(queuedClip.id);

  const uploadedClip = await queueManager.completeUpload(
    queuedClip.id,
    processedDir,
  );

  assert.equal(uploadedClip.status, "uploaded");
  assert.equal(uploadedClip.uploadedAt !== null, true);
  assert.equal(uploadedClip.routedAt !== null, true);
  assert.equal(uploadedClip.currentPath.startsWith(processedDir), true);
  assert.equal(await pathExists(clipPath), false);
  assert.equal(await pathExists(uploadedClip.currentPath), true);
});

test("upload attempt helpers report counts and preserve attempt ordering", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const firstEvent = await createClipEvent(runtime.camera1, "clip-a.mp4", "a");
  const secondEvent = await createClipEvent(runtime.camera2, "clip-b.mp4", "b");

  const { clip: firstClip } = await queueManager.enqueueClip(firstEvent.event, {
    checksum: "a",
    opencvEnabled: false,
  });
  const { clip: secondClip } = await queueManager.enqueueClip(
    secondEvent.event,
    {
      checksum: "b",
      opencvEnabled: false,
    },
  );

  await queueManager.acceptClip(firstClip.id, { decision: "accepted" });
  await queueManager.acceptClip(secondClip.id, { decision: "accepted" });

  const nextQueued = queueManager.getNextQueuedClip();

  assert.equal(nextQueued.id, firstClip.id);

  await queueManager.recordUploadAttempt(firstClip.id, {
    attemptNumber: 2,
    responseStatus: 429,
    errorSummary: "rate limited",
  });
  await queueManager.recordUploadAttempt(firstClip.id, {
    attemptNumber: 1,
    responseStatus: 500,
    errorSummary: "upstream error",
  });

  const attempts = queueManager.listUploadAttempts(firstClip.id);
  const attemptCount = queueManager.getUploadAttemptCount(firstClip.id);

  assert.equal(attemptCount, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attemptNumber),
    [1, 2],
  );
  assert.equal(attempts[0].errorSummary, "upstream error");
});

test("retryFailedUpload only allows failed clips and clears failure reason", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const { event } = await createClipEvent(
    runtime.camera1,
    "clip-failed.mp4",
    "c",
  );
  const { clip } = await queueManager.enqueueClip(event, {
    checksum: "failed",
    opencvEnabled: false,
  });

  await queueManager.failClip(clip.id, new Error("network timeout"));

  const retriedClip = await queueManager.retryFailedUpload(clip.id);

  assert.equal(retriedClip.status, "queued");
  assert.equal(retriedClip.failureReason, null);

  await assert.rejects(
    () => queueManager.retryFailedUpload(retriedClip.id),
    /Only failed clips can be retried/,
  );
});

test("getQueueSummary aggregates queue and failed counts", async (t) => {
  const runtime = await createRuntimeConfig();
  const queueManager = await createQueueManager(runtime.config);

  t.after(async () => {
    await queueManager.close();
    await fs.rm(runtime.root, { force: true, recursive: true });
  });

  const queuedEvent = await createClipEvent(
    runtime.camera1,
    "clip-queued.mp4",
    "q",
  );
  const failedEvent = await createClipEvent(
    runtime.camera2,
    "clip-failed-2.mp4",
    "f",
  );

  const { clip: queuedClip } = await queueManager.enqueueClip(
    queuedEvent.event,
    {
      checksum: "queued",
      opencvEnabled: false,
    },
  );
  const { clip: failedClip } = await queueManager.enqueueClip(
    failedEvent.event,
    {
      checksum: "failed",
      opencvEnabled: false,
    },
  );

  await queueManager.acceptClip(queuedClip.id, { decision: "accepted" });
  await queueManager.failClip(failedClip.id, "final failure");

  const summary = queueManager.getQueueSummary();

  assert.equal(summary.total, 2);
  assert.equal(summary.byStatus.queued, 1);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(summary.pendingUploads, 1);
  assert.equal(summary.failed, 1);
});
