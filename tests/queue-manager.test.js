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

test("QueueManager enqueues a clip exactly once per original path", async (t) => {
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

  assert.equal(firstInsert.created, true);
  assert.equal(secondInsert.created, false);
  assert.equal(firstInsert.clip.id, secondInsert.clip.id);
  assert.equal(firstInsert.clip.status, "ready");
  assert.equal(firstInsert.clip.opencvEnabled, true);

  const rowCount = queueManager.getRows(
    "SELECT COUNT(*) AS total FROM clips",
  )[0].total;

  assert.equal(rowCount, 1);
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
  await queueManager.acceptClip(uploadingClip.id, {
    decision: "accepted",
    reason: "queue",
  });
  await queueManager.transitionClip(uploadingClip.id, "queued", {
    queuedAt: new Date().toISOString(),
  });
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
