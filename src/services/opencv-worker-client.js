import { spawn } from "node:child_process";

export const OPENCV_DECISIONS = Object.freeze(["accepted", "rejected"]);

const DEFAULT_TIMEOUT_MS = 30000;

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return metadata;
}

export function normalizeWorkerResult(result) {
  const parsedResult = typeof result === "string" ? JSON.parse(result) : result;
  const decision = parsedResult?.decision;

  if (!OPENCV_DECISIONS.includes(decision)) {
    throw new Error(`Invalid OpenCV worker decision: ${decision}`);
  }

  return {
    decision,
    reason: parsedResult.reason ?? null,
    metadata: normalizeMetadata(parsedResult.metadata),
  };
}

function buildWorkerPayload(clip) {
  return {
    clipId: clip.id,
    sourceCamera: clip.sourceCamera,
    originalPath: clip.originalPath,
    currentPath: clip.currentPath,
    stableAt: clip.stableAt,
    checksum: clip.checksum,
    sizeBytes: clip.sizeBytes,
  };
}

async function collectProcessResult(child, payload, timeoutMs) {
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;

    const settle = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      callback(value);
    };

    timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // No-op: process may already be exiting.
      }

      settle(
        reject,
        new Error(`OpenCV worker process timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      settle(reject, error);
    });
    child.on("close", (code) => {
      settle(resolve, code);
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `OpenCV worker exited with ${exitCode}`);
  }

  return normalizeWorkerResult(stdout.trim());
}

export class OpenCvWorkerClient {
  constructor(config, options = {}) {
    const opencvConfig = config.opencv ?? {};

    this.enabled = options.enabled ?? config.features.opencvEnabled;
    this.workerCommand =
      options.workerCommand ?? opencvConfig.workerCommand ?? null;
    this.workerArgs = options.workerArgs ?? opencvConfig.workerArgs ?? [];
    this.workerUrl = options.workerUrl ?? opencvConfig.workerUrl ?? null;
    this.timeoutMs =
      options.timeoutMs ?? opencvConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async decideClip(clip) {
    if (!this.enabled) {
      return {
        decision: "accepted",
        reason: "opencv disabled",
        metadata: { skipped: true },
      };
    }

    if (this.workerUrl) {
      return this.decideViaHttp(clip);
    }

    if (this.workerCommand) {
      return this.decideViaProcess(clip);
    }

    throw new Error(
      "OpenCV is enabled but no worker command or URL is configured.",
    );
  }

  async decideViaHttp(clip) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.workerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(buildWorkerPayload(clip)),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenCV worker HTTP ${response.status}`);
      }

      return normalizeWorkerResult(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async decideViaProcess(clip) {
    const child = spawn(this.workerCommand, this.workerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    return collectProcessResult(
      child,
      buildWorkerPayload(clip),
      this.timeoutMs,
    );
  }
}
