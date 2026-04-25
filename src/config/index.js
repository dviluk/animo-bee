import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3001;
const DEFAULT_OPENCV_TIMEOUT_MS = 30000;
const DEFAULT_UPLOAD_MAX_ATTEMPTS = 3;
const DEFAULT_UPLOAD_POLL_INTERVAL_MS = 5000;
const DEFAULT_UPLOAD_RETRY_DELAY_MS = 30000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 60000;
const DEFAULT_IRRIGATION_TIMEOUT_MS = 10000;
const DEFAULT_PATHS = {
  camera1: "./runtime/camera_1",
  camera2: "./runtime/camera_2",
  processed: "./runtime/processed",
  rejected: "./runtime/rejected",
  database: "./runtime/db/orchestrator.sqlite",
  logs: "./runtime/logs",
};

function parsePort(rawPort) {
  const port = Number.parseInt(rawPort ?? `${DEFAULT_PORT}`, 10);

  if (Number.isInteger(port) && port > 0) {
    return port;
  }

  throw new Error(`Invalid PORT value: ${rawPort}`);
}

function parsePositiveInteger(rawValue, defaultValue, name) {
  const value = Number.parseInt(rawValue ?? `${defaultValue}`, 10);

  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  throw new Error(`Invalid ${name} value: ${rawValue}`);
}

function parseBoolean(rawValue, defaultValue = false) {
  if (rawValue === undefined) {
    return defaultValue;
  }

  return rawValue === "true";
}

function parseHeaderJson(rawHeaders, name) {
  if (!rawHeaders) {
    return {};
  }

  const headers = JSON.parse(rawHeaders);

  if (
    !headers ||
    Array.isArray(headers) ||
    Object.values(headers).some((value) => typeof value !== "string")
  ) {
    throw new Error(`${name} must be a JSON object with string values.`);
  }

  return headers;
}

function parseWorkerArgs(rawArgs) {
  if (!rawArgs) {
    return [];
  }

  const args = JSON.parse(rawArgs);

  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("OPENCV_WORKER_ARGS must be a JSON string array.");
  }

  return args;
}

function resolvePath(inputPath) {
  if (!inputPath) {
    throw new Error("Missing runtime path configuration.");
  }

  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }

  return path.resolve(process.cwd(), inputPath);
}

export function loadConfig() {
  const opencvEnabled = parseBoolean(process.env.OPENCV_ENABLED);
  const uploadEnabled = parseBoolean(process.env.UPLOAD_ENABLED);
  const irrigationEnabled = parseBoolean(process.env.IRRIGATION_ENABLED);

  return {
    mode: process.env.APP_MODE ?? "development",
    server: {
      host: process.env.HOST ?? DEFAULT_HOST,
      port: parsePort(process.env.PORT),
    },
    paths: {
      cameraSources: [
        resolvePath(process.env.CAMERA_1_DIR ?? DEFAULT_PATHS.camera1),
        resolvePath(process.env.CAMERA_2_DIR ?? DEFAULT_PATHS.camera2),
      ],
      processedDir: resolvePath(
        process.env.PROCESSED_DIR ?? DEFAULT_PATHS.processed,
      ),
      rejectedDir: resolvePath(
        process.env.REJECTED_DIR ?? DEFAULT_PATHS.rejected,
      ),
      dbPath: resolvePath(process.env.DB_PATH ?? DEFAULT_PATHS.database),
      logDir: resolvePath(process.env.LOG_DIR ?? DEFAULT_PATHS.logs),
    },
    features: {
      opencvEnabled,
      uploadEnabled,
      irrigationEnabled,
    },
    opencv: {
      enabled: opencvEnabled,
      workerCommand: process.env.OPENCV_WORKER_COMMAND ?? null,
      workerArgs: parseWorkerArgs(process.env.OPENCV_WORKER_ARGS),
      workerUrl: process.env.OPENCV_WORKER_URL ?? null,
      timeoutMs: parsePositiveInteger(
        process.env.OPENCV_TIMEOUT_MS,
        DEFAULT_OPENCV_TIMEOUT_MS,
        "OPENCV_TIMEOUT_MS",
      ),
    },
    upload: {
      enabled: uploadEnabled,
      url: process.env.UPLOAD_URL ?? null,
      headers: parseHeaderJson(
        process.env.UPLOAD_HEADERS_JSON,
        "UPLOAD_HEADERS_JSON",
      ),
      maxAttempts: parsePositiveInteger(
        process.env.UPLOAD_MAX_ATTEMPTS,
        DEFAULT_UPLOAD_MAX_ATTEMPTS,
        "UPLOAD_MAX_ATTEMPTS",
      ),
      pollIntervalMs: parsePositiveInteger(
        process.env.UPLOAD_POLL_INTERVAL_MS,
        DEFAULT_UPLOAD_POLL_INTERVAL_MS,
        "UPLOAD_POLL_INTERVAL_MS",
      ),
      retryDelayMs: parsePositiveInteger(
        process.env.UPLOAD_RETRY_DELAY_MS,
        DEFAULT_UPLOAD_RETRY_DELAY_MS,
        "UPLOAD_RETRY_DELAY_MS",
      ),
      timeoutMs: parsePositiveInteger(
        process.env.UPLOAD_TIMEOUT_MS,
        DEFAULT_UPLOAD_TIMEOUT_MS,
        "UPLOAD_TIMEOUT_MS",
      ),
    },
    irrigation: {
      enabled: irrigationEnabled,
      triggerUrl: process.env.IRRIGATION_TRIGGER_URL ?? null,
      headers: parseHeaderJson(
        process.env.IRRIGATION_HEADERS_JSON,
        "IRRIGATION_HEADERS_JSON",
      ),
      timeoutMs: parsePositiveInteger(
        process.env.IRRIGATION_TIMEOUT_MS,
        DEFAULT_IRRIGATION_TIMEOUT_MS,
        "IRRIGATION_TIMEOUT_MS",
      ),
    },
  };
}

export async function ensureRuntimeDirectories(config) {
  const directories = [
    ...config.paths.cameraSources,
    config.paths.processedDir,
    config.paths.rejectedDir,
    config.paths.logDir,
    path.dirname(config.paths.dbPath),
  ];

  await Promise.all(
    directories.map((directoryPath) =>
      fs.mkdir(directoryPath, { recursive: true }),
    ),
  );
}
