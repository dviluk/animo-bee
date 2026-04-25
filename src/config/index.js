import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3001;
const DEFAULT_OPENCV_TIMEOUT_MS = 30000;
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
  const opencvEnabled = process.env.OPENCV_ENABLED === "true";

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
