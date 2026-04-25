import { pathToFileURL } from "node:url";
import { createControlApiServer } from "./api/server.js";
import { ensureRuntimeDirectories, loadConfig } from "./config/index.js";
import {
  CLIP_DETECTED_EVENT,
  startClipWatcher,
} from "./services/file-watcher.js";
import { OpenCvWorkerClient } from "./services/opencv-worker-client.js";
import { ConfigManager } from "./services/config-manager.js";
import { IrrigationController } from "./services/irrigation-controller.js";
import { createQueueManager } from "./services/queue-manager.js";
import { UploadWorker } from "./services/upload-worker.js";

function logClipDetected(event) {
  console.log(JSON.stringify({ event: CLIP_DETECTED_EVENT, data: event }));
}

function logClipQueued(clip) {
  console.log(
    JSON.stringify({
      event: "clip_queued",
      data: {
        id: clip.id,
        status: clip.status,
        originalPath: clip.originalPath,
      },
    }),
  );
}

async function handleClipDetected(event, services) {
  const { config, opencvWorkerClient, queueManager } = services;
  const { clip, created } = await queueManager.enqueueClip(event, {
    opencvEnabled: config.features.opencvEnabled,
  });

  if (!created) {
    return clip;
  }

  let activeClip = clip;

  try {
    if (config.features.opencvEnabled) {
      activeClip = await queueManager.markProcessing(clip.id);
    }

    const decision = await opencvWorkerClient.decideClip(activeClip);
    const finalClip =
      decision.decision === "rejected"
        ? await queueManager.rejectClip(
            activeClip.id,
            decision,
            config.paths.rejectedDir,
          )
        : await queueManager.acceptClip(activeClip.id, decision);

    logClipQueued(finalClip);

    return finalClip;
  } catch (error) {
    await queueManager.failClip(activeClip.id, error);
    throw error;
  }
}

function supportsRuntimeConfig(queueManager) {
  return (
    typeof queueManager?.getRuntimeConfig === "function" &&
    typeof queueManager?.setRuntimeConfig === "function"
  );
}

function supportsUploadWorker(queueManager) {
  return (
    typeof queueManager?.getNextQueuedClip === "function" &&
    typeof queueManager?.markUploading === "function" &&
    typeof queueManager?.completeUpload === "function"
  );
}

function supportsIrrigationController(queueManager) {
  return typeof queueManager?.recordIrrigationEvent === "function";
}

export function createAppServer(config, services = {}) {
  return createControlApiServer(config, services);
}

export async function startServer(config = loadConfig(), options = {}) {
  const startWatcher = options.startWatcher ?? true;
  const startQueue = options.startQueue ?? true;
  const startUploadWorker = options.startUploadWorker ?? true;

  let queueManager = null;
  let configManager = null;
  let uploadWorker = null;
  let irrigationController = null;
  let resumableClips = [];

  await ensureRuntimeDirectories(config);

  if (startQueue) {
    queueManager = options.queueManager ?? (await createQueueManager(config));
    resumableClips = await queueManager.recoverPendingWork();

    if (options.onRecoveredClips) {
      await options.onRecoveredClips(resumableClips);
    }

    if (supportsRuntimeConfig(queueManager)) {
      configManager =
        options.configManager ?? new ConfigManager(config, queueManager);
      await configManager.hydrate();
    }

    if (supportsUploadWorker(queueManager)) {
      uploadWorker =
        options.uploadWorker ?? new UploadWorker(config, queueManager);
    }

    if (supportsIrrigationController(queueManager)) {
      irrigationController =
        options.irrigationController ??
        new IrrigationController(config, queueManager);
    }
  }

  const opencvWorkerClient =
    options.opencvWorkerClient ?? new OpenCvWorkerClient(config);

  const server = createAppServer(config, {
    queueManager,
    configManager,
    uploadWorker,
    irrigationController,
    opencvWorkerClient,
  });

  server.queueManager = queueManager;
  server.configManager = configManager;
  server.uploadWorker = uploadWorker;
  server.irrigationController = irrigationController;
  server.opencvWorkerClient = opencvWorkerClient;
  server.resumableClips = resumableClips;

  const onClipDetected =
    options.onClipDetected ??
    (server.queueManager
      ? (event) =>
          handleClipDetected(event, {
            config,
            opencvWorkerClient: server.opencvWorkerClient,
            queueManager: server.queueManager,
          })
      : logClipDetected);

  if (startWatcher) {
    server.clipWatcher = await startClipWatcher(config, { onClipDetected });
  }

  if (startUploadWorker) {
    server.uploadWorker?.start();
  }

  await new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, resolve);
  });

  return server;
}

export async function stopServer(server) {
  await server.clipWatcher?.stop();
  await server.uploadWorker?.stop();
  await server.queueManager?.close();

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function main() {
  const config = loadConfig();
  const server = await startServer(config);

  console.log(
    `animo-bee scaffold listening on http://${config.server.host}:${config.server.port}`,
  );

  const shutdown = async (signal) => {
    console.log(`animo-bee shutting down on ${signal}`);
    await stopServer(server);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
