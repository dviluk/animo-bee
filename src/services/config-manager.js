const OPENCV_ENABLED_KEY = "opencv_enabled";
const OPENCV_MODE_KEY = "opencv_mode";
const OPENCV_FAIL_OPEN_KEY = "opencv_fail_open";
const OPENCV_RETAIN_REJECTED_FILES_KEY = "opencv_retain_rejected_files";
const OPENCV_MIN_MOTION_DURATION_MS_KEY = "opencv_min_motion_duration_ms";
const OPENCV_MAX_BRIGHTNESS_CHANGE_KEY = "opencv_max_brightness_change";
const OPENCV_MIN_ROI_MOTION_SCORE_KEY = "opencv_min_roi_motion_score";

const OPENCV_MODES = new Set(["disabled", "shadow", "enforce"]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeBoolean(value, name = "value") {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be boolean.`);
  }

  return value;
}

function normalizeOpenCvMode(value) {
  if (typeof value !== "string" || !OPENCV_MODES.has(value)) {
    throw new Error(
      `mode must be one of: ${Array.from(OPENCV_MODES).join(", ")}.`,
    );
  }

  return value;
}

function normalizePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function normalizeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

function createValidationError(message) {
  return Object.assign(new Error(message), {
    statusCode: 422,
  });
}

function hasWorkerContract(config, workerConfiguredOverride) {
  if (typeof workerConfiguredOverride === "boolean") {
    return workerConfiguredOverride;
  }

  return Boolean(config?.opencv?.workerUrl ?? config?.opencv?.workerCommand);
}

export class ConfigManager {
  constructor(config, queueManager) {
    this.config = config;
    this.queueManager = queueManager;
  }

  getOpenCvDefaults() {
    return {
      mode:
        this.config.opencv?.mode ??
        (this.config.features.opencvEnabled ? "shadow" : "disabled"),
      failOpen: this.config.opencv?.failOpen ?? true,
      retainRejectedFiles: this.config.opencv?.retainRejectedFiles ?? true,
      minMotionDurationMs: this.config.opencv?.minMotionDurationMs ?? 500,
      maxBrightnessChange: this.config.opencv?.maxBrightnessChange ?? 0.25,
      minRoiMotionScore: this.config.opencv?.minRoiMotionScore ?? 0.4,
    };
  }

  getOpenCvRuntime() {
    const defaults = this.getOpenCvDefaults();

    const mode = normalizeOpenCvMode(
      this.queueManager.getRuntimeConfig(OPENCV_MODE_KEY) ?? defaults.mode,
    );
    const enabled =
      this.queueManager.getRuntimeConfig(OPENCV_ENABLED_KEY) ??
      mode !== "disabled";
    const failOpen =
      this.queueManager.getRuntimeConfig(OPENCV_FAIL_OPEN_KEY) ??
      defaults.failOpen;
    const retainRejectedFiles =
      this.queueManager.getRuntimeConfig(OPENCV_RETAIN_REJECTED_FILES_KEY) ??
      defaults.retainRejectedFiles;
    const minMotionDurationMs =
      this.queueManager.getRuntimeConfig(OPENCV_MIN_MOTION_DURATION_MS_KEY) ??
      defaults.minMotionDurationMs;
    const maxBrightnessChange =
      this.queueManager.getRuntimeConfig(OPENCV_MAX_BRIGHTNESS_CHANGE_KEY) ??
      defaults.maxBrightnessChange;
    const minRoiMotionScore =
      this.queueManager.getRuntimeConfig(OPENCV_MIN_ROI_MOTION_SCORE_KEY) ??
      defaults.minRoiMotionScore;

    const resolvedMode = mode === "disabled" && enabled ? "shadow" : mode;
    const resolvedEnabled = resolvedMode !== "disabled";

    return {
      mode: resolvedMode,
      enabled: normalizeBoolean(resolvedEnabled, "enabled"),
      failOpen: normalizeBoolean(failOpen, "failOpen"),
      retainRejectedFiles: normalizeBoolean(
        retainRejectedFiles,
        "retainRejectedFiles",
      ),
      minMotionDurationMs: normalizePositiveInteger(
        minMotionDurationMs,
        "minMotionDurationMs",
      ),
      maxBrightnessChange: normalizeNumber(
        maxBrightnessChange,
        "maxBrightnessChange",
      ),
      minRoiMotionScore: normalizeNumber(
        minRoiMotionScore,
        "minRoiMotionScore",
      ),
    };
  }

  applyOpenCvRuntime(runtime) {
    this.config.features.opencvEnabled = runtime.enabled;
    this.config.opencv ??= {};
    this.config.opencv.enabled = runtime.enabled;
    this.config.opencv.mode = runtime.mode;
    this.config.opencv.failOpen = runtime.failOpen;
    this.config.opencv.retainRejectedFiles = runtime.retainRejectedFiles;
    this.config.opencv.minMotionDurationMs = runtime.minMotionDurationMs;
    this.config.opencv.maxBrightnessChange = runtime.maxBrightnessChange;
    this.config.opencv.minRoiMotionScore = runtime.minRoiMotionScore;

    return runtime;
  }

  getOpenCvEnabled() {
    return this.getOpenCvRuntime().enabled;
  }

  async setOpenCvRuntime(payload = {}, options = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be an object.");
    }

    const current = this.getOpenCvRuntime();
    const nextMode = hasOwn(payload, "mode")
      ? normalizeOpenCvMode(payload.mode)
      : hasOwn(payload, "enabled")
        ? normalizeBoolean(payload.enabled, "enabled")
          ? "shadow"
          : "disabled"
        : current.mode;

    const next = {
      mode: nextMode,
      enabled: nextMode !== "disabled",
      failOpen: hasOwn(payload, "failOpen")
        ? normalizeBoolean(payload.failOpen, "failOpen")
        : current.failOpen,
      retainRejectedFiles: hasOwn(payload, "retainRejectedFiles")
        ? normalizeBoolean(payload.retainRejectedFiles, "retainRejectedFiles")
        : current.retainRejectedFiles,
      minMotionDurationMs: hasOwn(payload, "minMotionDurationMs")
        ? normalizePositiveInteger(
            payload.minMotionDurationMs,
            "minMotionDurationMs",
          )
        : current.minMotionDurationMs,
      maxBrightnessChange: hasOwn(payload, "maxBrightnessChange")
        ? normalizeNumber(payload.maxBrightnessChange, "maxBrightnessChange")
        : current.maxBrightnessChange,
      minRoiMotionScore: hasOwn(payload, "minRoiMotionScore")
        ? normalizeNumber(payload.minRoiMotionScore, "minRoiMotionScore")
        : current.minRoiMotionScore,
    };

    const workerConfigured = hasWorkerContract(
      this.config,
      options.workerConfigured,
    );

    if (next.mode !== "disabled" && !workerConfigured) {
      throw createValidationError(
        "OpenCV mode requires OPENCV_WORKER_URL or OPENCV_WORKER_COMMAND.",
      );
    }

    await this.queueManager.setRuntimeConfig(OPENCV_MODE_KEY, next.mode);
    await this.queueManager.setRuntimeConfig(OPENCV_ENABLED_KEY, next.enabled);
    await this.queueManager.setRuntimeConfig(
      OPENCV_FAIL_OPEN_KEY,
      next.failOpen,
    );
    await this.queueManager.setRuntimeConfig(
      OPENCV_RETAIN_REJECTED_FILES_KEY,
      next.retainRejectedFiles,
    );
    await this.queueManager.setRuntimeConfig(
      OPENCV_MIN_MOTION_DURATION_MS_KEY,
      next.minMotionDurationMs,
    );
    await this.queueManager.setRuntimeConfig(
      OPENCV_MAX_BRIGHTNESS_CHANGE_KEY,
      next.maxBrightnessChange,
    );
    await this.queueManager.setRuntimeConfig(
      OPENCV_MIN_ROI_MOTION_SCORE_KEY,
      next.minRoiMotionScore,
    );

    return this.applyOpenCvRuntime(next);
  }

  async setOpenCvEnabled(value, options = {}) {
    const runtime = await this.setOpenCvRuntime(
      {
        enabled: normalizeBoolean(value, "enabled"),
      },
      options,
    );

    return runtime.enabled;
  }

  async hydrate() {
    const runtime = this.applyOpenCvRuntime(this.getOpenCvRuntime());

    return {
      opencvEnabled: runtime.enabled,
      opencv: runtime,
    };
  }
}
