import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";

export const CLIP_DETECTED_EVENT = "clip_detected";

const DEFAULT_STABILITY_ATTEMPTS = 5;
const DEFAULT_STABILITY_DELAY_MS = 1000;
const IGNORED_FILE_SUFFIXES = [
  ".crdownload",
  ".download",
  ".part",
  ".partial",
  ".swp",
  ".tmp",
];

function delay(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeFilePath(filePath) {
  return path.normalize(path.resolve(filePath));
}

function isInsideDirectory(filePath, directoryPath) {
  const relativePath = path.relative(directoryPath, filePath);

  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

export function shouldIgnoreClipFile(filePath) {
  const fileName = path.basename(filePath);
  const lowerFileName = fileName.toLowerCase();

  return (
    fileName.startsWith(".") ||
    IGNORED_FILE_SUFFIXES.some((suffix) => lowerFileName.endsWith(suffix))
  );
}

export async function waitForStableFile(
  filePath,
  options = {},
) {
  const attempts = options.attempts ?? DEFAULT_STABILITY_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_STABILITY_DELAY_MS;
  let previousSize = -1;
  let lastStats = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stats = await fs.stat(filePath);

    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    if (stats.size > 0 && stats.size === previousSize) {
      return stats;
    }

    previousSize = stats.size;
    lastStats = stats;

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  if (lastStats?.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }

  throw new Error(`File did not stabilize: ${filePath}`);
}

export function createClipDetectedEvent(filePath, stats, cameraSources) {
  const normalizedPath = normalizeFilePath(filePath);
  const cameraSource = cameraSources.find((sourcePath) =>
    isInsideDirectory(normalizedPath, sourcePath),
  );

  return {
    type: CLIP_DETECTED_EVENT,
    sourceCamera: cameraSource ? path.basename(cameraSource) : "unknown",
    originalPath: normalizedPath,
    stableAt: new Date().toISOString(),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

export class ClipWatcher {
  constructor(config, options = {}) {
    this.cameraSources = config.paths.cameraSources.map(normalizeFilePath);
    this.onClipDetected = options.onClipDetected ?? (() => {});
    this.onError = options.onError ?? ((error) => console.error(error));
    this.stability = {
      attempts: options.stability?.attempts ?? DEFAULT_STABILITY_ATTEMPTS,
      delayMs: options.stability?.delayMs ?? DEFAULT_STABILITY_DELAY_MS,
    };
    this.pendingPaths = new Set();
    this.emittedPaths = new Set();
    this.closed = false;
    this.watcher = null;
  }

  async start() {
    if (this.watcher) {
      return this;
    }

    this.closed = false;
    this.watcher = chokidar.watch(this.cameraSources, {
      awaitWriteFinish: false,
      depth: undefined,
      ignoreInitial: false,
      ignored: (filePath) => shouldIgnoreClipFile(filePath),
      persistent: true,
    });

    this.watcher.on("add", (filePath) => {
      void this.processCandidate(filePath);
    });

    this.watcher.on("change", (filePath) => {
      void this.processCandidate(filePath);
    });

    this.watcher.on("error", (error) => {
      this.onError(error);
    });

    await new Promise((resolve, reject) => {
      this.watcher.once("ready", resolve);
      this.watcher.once("error", reject);
    });

    return this;
  }

  async stop() {
    this.closed = true;

    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.watcher = null;
    this.pendingPaths.clear();
  }

  async processCandidate(filePath) {
    const normalizedPath = normalizeFilePath(filePath);

    if (
      this.closed ||
      shouldIgnoreClipFile(normalizedPath) ||
      this.pendingPaths.has(normalizedPath) ||
      this.emittedPaths.has(normalizedPath)
    ) {
      return;
    }

    this.pendingPaths.add(normalizedPath);

    try {
      const stats = await waitForStableFile(normalizedPath, this.stability);

      if (this.closed || this.emittedPaths.has(normalizedPath)) {
        return;
      }

      const event = createClipDetectedEvent(
        normalizedPath,
        stats,
        this.cameraSources,
      );

      await this.onClipDetected(event);
      this.emittedPaths.add(normalizedPath);
    } catch (error) {
      if (!this.closed && error.code !== "ENOENT") {
        this.onError(error);
      }
    } finally {
      this.pendingPaths.delete(normalizedPath);
    }
  }
}

export async function startClipWatcher(config, options = {}) {
  const watcher = new ClipWatcher(config, options);

  await watcher.start();

  return watcher;
}
