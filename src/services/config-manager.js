const OPENCV_ENABLED_KEY = "opencv_enabled";

function normalizeBoolean(value) {
  if (typeof value !== "boolean") {
    throw new Error("Expected boolean value.");
  }

  return value;
}

export class ConfigManager {
  constructor(config, queueManager) {
    this.config = config;
    this.queueManager = queueManager;
  }

  getOpenCvEnabled() {
    return (
      this.queueManager.getRuntimeConfig(OPENCV_ENABLED_KEY) ??
      this.config.features.opencvEnabled
    );
  }

  async setOpenCvEnabled(value) {
    const enabled = normalizeBoolean(value);

    await this.queueManager.setRuntimeConfig(OPENCV_ENABLED_KEY, enabled);
    this.config.features.opencvEnabled = enabled;
    this.config.opencv ??= {};
    this.config.opencv.enabled = enabled;

    return enabled;
  }

  async hydrate() {
    const enabled = this.getOpenCvEnabled();

    this.config.features.opencvEnabled = enabled;
    this.config.opencv ??= {};
    this.config.opencv.enabled = enabled;

    return {
      opencvEnabled: enabled,
    };
  }
}
