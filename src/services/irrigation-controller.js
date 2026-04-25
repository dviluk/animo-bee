const DEFAULT_IRRIGATION_CONFIG = Object.freeze({
  enabled: false,
  triggerUrl: null,
  headers: {},
  timeoutMs: 10000,
});

function errorSummary(error) {
  return error instanceof Error ? error.message : String(error);
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return { controller, timeout };
}

export class IrrigationController {
  constructor(config, queueManager, options = {}) {
    this.config = {
      ...DEFAULT_IRRIGATION_CONFIG,
      ...(config.irrigation ?? {}),
    };
    this.queueManager = queueManager;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  getStatus() {
    return {
      enabled: Boolean(this.config.enabled),
      configured: Boolean(this.config.triggerUrl),
    };
  }

  async trigger(action, payload = {}) {
    if (!this.config.enabled || !this.config.triggerUrl) {
      const result = {
        ok: false,
        error: "Irrigation trigger URL is not configured.",
      };

      await this.record(action, payload, result);

      return result;
    }

    if (typeof this.fetch !== "function") {
      throw new Error("Fetch API is not available in this runtime.");
    }

    const requestPayload = { action, payload };
    const { controller, timeout } = createAbortSignal(this.config.timeoutMs);

    try {
      const response = await this.fetch(this.config.triggerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      const responseBody = await response.text();
      const result = {
        ok: response.ok,
        responseStatus: response.status,
        responseBody: responseBody.slice(0, 2000),
      };

      await this.record(action, payload, result);

      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: errorSummary(error),
      };

      await this.record(action, payload, result);

      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async record(action, payload, result) {
    if (!this.queueManager?.recordIrrigationEvent) {
      return;
    }

    await this.queueManager.recordIrrigationEvent({
      action,
      payload,
      result,
    });
  }
}
