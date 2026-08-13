import { openAsBlob } from "node:fs";
import path from "node:path";

const DEFAULT_UPLOAD_CONFIG = Object.freeze({
  enabled: false,
  url: null,
  headers: {},
  domainProfile: "pollination",
  checkType: "pollination_activity",
  sourceChannel: "edge_device",
  externalSourceKey: null,
  deviceId: null,
  processingMode: null,
  backendProcessing: null,
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

function inferMediaKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  // .mkv is motionEye's default movie_codec output — see config/motioneye/*.conf
  if ([".mkv", ".mp4", ".mov", ".avi", ".webm"].includes(extension)) {
    return "video";
  }

  return "image";
}

function inferMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".avi": "video/x-msvideo",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };

  return mimeTypes[extension] ?? "application/octet-stream";
}

function appendFormValue(formData, key, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      appendFormValue(formData, `${key}[${index}]`, item);
    });

    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([nestedKey, nestedValue]) => {
      appendFormValue(formData, `${key}[${nestedKey}]`, nestedValue);
    });

    return;
  }

  formData.append(key, String(value));
}

function resolveProcessingMode(config, clip) {
  if (config.processingMode) {
    return config.processingMode;
  }

  return clip.opencvMode === "disabled" ? "raw" : "edge_prefiltered";
}

function resolveBackendProcessing(config) {
  return config.backendProcessing ?? "required";
}

function buildIdempotencyKey(config, clip) {
  const sourceIdentity =
    config.externalSourceKey ?? config.deviceId ?? clip.sourceCamera ?? "edge";

  return `${sourceIdentity}:${clip.id}:${clip.checksum ?? "no-checksum"}`;
}

function buildSourceClipId(clip) {
  return clip.sourceCamera
    ? `${clip.sourceCamera}:${clip.id}`
    : String(clip.id);
}

function buildEdgeMetadata(clip, processingMode, attemptNumber) {
  return {
    edge_prefilter: {
      clip_id: clip.id,
      source_camera: clip.sourceCamera,
      processing_mode: processingMode,
      opencv_mode: clip.opencvMode,
      opencv_status: clip.opencvStatus,
      opencv_decision: clip.opencvDecision,
      opencv_reason: clip.opencvReason,
      opencv_error: clip.opencvError,
      opencv_processed_at: clip.opencvProcessedAt,
      opencv_scores: clip.opencvScores ?? {},
    },
    edge_upload: {
      attempt_number: attemptNumber,
      queued_at: clip.queuedAt,
    },
  };
}

async function buildUploadBody(config, clip, attemptNumber) {
  const mediaKind = inferMediaKind(clip.currentPath);
  const mimeType = inferMimeType(clip.currentPath);
  const filename = path.basename(clip.currentPath);
  const processingMode = resolveProcessingMode(config, clip);
  const backendProcessing = resolveBackendProcessing(config);
  const formData = new FormData();
  const fileBlob = await openAsBlob(clip.currentPath, { type: mimeType });

  formData.append("file", fileBlob, filename);
  formData.append("check_type", config.checkType);
  formData.append("domain_profile", config.domainProfile);
  formData.append("media_kind", mediaKind);
  formData.append("source_channel", config.sourceChannel);
  formData.append("processing_mode", processingMode);
  formData.append("backend_processing", backendProcessing);
  appendFormValue(formData, "device_id", config.deviceId);
  appendFormValue(formData, "camera_id", clip.sourceCamera);
  appendFormValue(formData, "external_source_key", config.externalSourceKey);
  appendFormValue(formData, "source_clip_id", buildSourceClipId(clip));
  appendFormValue(formData, "checksum", clip.checksum);
  appendFormValue(
    formData,
    "idempotency_key",
    buildIdempotencyKey(config, clip),
  );
  appendFormValue(
    formData,
    "metadata",
    buildEdgeMetadata(clip, processingMode, attemptNumber),
  );

  return {
    body: formData,
    headers: {
      "x-animo-clip-id": String(clip.id),
      "x-animo-source-camera": clip.sourceCamera ?? "",
      "x-animo-checksum": clip.checksum ?? "",
      "x-animo-original-filename": filename,
      "Idempotency-Key": buildIdempotencyKey(config, clip),
      ...config.headers,
    },
  };
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
      const uploadResult = await this.uploadClip(uploadingClip, attemptNumber);

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

  async uploadClip(clip, attemptNumber) {
    if (typeof this.fetch !== "function") {
      throw new Error("Fetch API is not available in this runtime.");
    }

    const { controller, timeout } = createAbortSignal(this.config.timeoutMs);
    const { body, headers } = await buildUploadBody(
      this.config,
      clip,
      attemptNumber,
    );

    try {
      const response = await this.fetch(this.config.url, {
        method: "POST",
        headers,
        body,
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
