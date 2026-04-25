import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_UPLOAD_CONFIG = Object.freeze({
  enabled: false,
  url: null,
  headers: {},
  maxAttempts: 3,
  pollIntervalMs: 5000,
  retryDelayMs: 30000,
  timeoutMs: 60000,
});

function errorSummary(error) {
  return error instanceof Error ? error.message : String(error);
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return { controller, timeout };
}

export class UploadWorker {
  constructor(config, queueManager, options = {}) {
    this.config = {
      ...DEFAULT_UPLOAD_CONFIG,
      ...(config.upload ?? {}),
    };
    this.queueManager = queueManager;
    this.processedDirectory =
      options.processedDirectory ?? config.paths.processedDir;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.inFlightClipId = null;
    this.lastError = null;
    this.lastResult = null;
    this.lastRunAt = null;
  }

  isConfigured() {
    return Boolean(this.config.enabled && this.config.url);
  }

  start() {
    if (!this.isConfigured() || this.timer) {
      return;
    }

    this.stopped = false;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(delayMs) {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(async () => {
      this.timer = null;

      try {
        const result = await this.runOnce();
        this.schedule(result.retryAfterMs ?? this.config.pollIntervalMs);
      } catch (error) {
        this.lastError = errorSummary(error);
        this.schedule(this.config.retryDelayMs);
      }
    }, delayMs);
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.enabled),
      configured: Boolean(this.config.url),
      running: !this.stopped,
      active: this.running,
      inFlightClipId: this.inFlightClipId,
      lastError: this.lastError,
      lastResult: this.lastResult,
      lastRunAt: this.lastRunAt,
    };
  }

  async wake() {
    if (!this.isConfigured() || this.stopped) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.schedule(0);
  }

  async runOnce() {
    if (!this.isConfigured()) {
      return { status: "disabled" };
    }

    if (this.running) {
      return { status: "busy" };
    }

    this.running = true;
    this.lastRunAt = new Date().toISOString();

    try {
      const clip = this.queueManager.getNextQueuedClip();

      if (!clip) {
        this.lastResult = { status: "idle" };
        return this.lastResult;
      }

      const result = await this.processClip(clip);
      this.lastResult = result;
      return result;
    } finally {
      this.running = false;
      this.inFlightClipId = null;
    }
  }

  async processClip(clip) {
    const previousAttempts =
      typeof this.queueManager.getUploadAttemptBudgetCount === "function"
        ? this.queueManager.getUploadAttemptBudgetCount(clip.id)
        : this.queueManager.getUploadAttemptCount(clip.id);

    if (previousAttempts >= this.config.maxAttempts) {
      const failedClip = await this.queueManager.failClip(
        clip.id,
        `Upload attempts exhausted after ${previousAttempts} attempts`,
      );

      return { status: "exhausted", clip: failedClip };
    }

    const attemptNumber = previousAttempts + 1;
    const uploadingClip = await this.queueManager.markUploading(clip.id);
    this.inFlightClipId = uploadingClip.id;

    try {
      const uploadResult = await this.uploadClip(uploadingClip);

      await this.queueManager.recordUploadAttempt(uploadingClip.id, {
        attemptNumber,
        responseStatus: uploadResult.responseStatus,
      });

      const uploadedClip = await this.queueManager.completeUpload(
        uploadingClip.id,
        this.processedDirectory,
      );

      return {
        status: "uploaded",
        clip: uploadedClip,
        attemptNumber,
        responseStatus: uploadResult.responseStatus,
      };
    } catch (error) {
      await this.queueManager.recordUploadAttempt(uploadingClip.id, {
        attemptNumber,
        responseStatus: error.responseStatus ?? null,
        errorSummary: errorSummary(error),
      });

      if (attemptNumber >= this.config.maxAttempts) {
        const failedClip = await this.queueManager.failClip(
          uploadingClip.id,
          error,
        );

        return {
          status: "failed",
          clip: failedClip,
          attemptNumber,
          retryAfterMs: this.config.retryDelayMs,
        };
      }

      const queuedClip = await this.queueManager.requeueUpload(
        uploadingClip.id,
        error,
      );

      return {
        status: "queued_for_retry",
        clip: queuedClip,
        attemptNumber,
        retryAfterMs: this.config.retryDelayMs,
      };
    }
  }

  async uploadClip(clip) {
    if (typeof this.fetch !== "function") {
      throw new Error("Fetch API is not available in this runtime.");
    }

    const stats = await fs.stat(clip.currentPath);
    const { controller, timeout } = createAbortSignal(this.config.timeoutMs);

    try {
      const response = await this.fetch(this.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(stats.size),
          "x-animo-clip-id": String(clip.id),
          "x-animo-source-camera": clip.sourceCamera ?? "",
          "x-animo-checksum": clip.checksum ?? "",
          "x-animo-original-filename": path.basename(clip.currentPath),
          ...this.config.headers,
        },
        body: createReadStream(clip.currentPath),
        duplex: "half",
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`Upload failed with HTTP ${response.status}`);
        error.responseStatus = response.status;
        throw error;
      }

      return { responseStatus: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }
}
