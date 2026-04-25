import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

export const CLIP_STATES = Object.freeze([
  "detected",
  "ready",
  "processing",
  "accepted",
  "rejected",
  "queued",
  "uploading",
  "uploaded",
  "failed",
]);

export const RESUMABLE_CLIP_STATES = Object.freeze([
  "ready",
  "processing",
  "accepted",
  "queued",
  "uploading",
  "failed",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  detected: ["ready", "failed"],
  ready: ["processing", "accepted", "queued", "failed"],
  processing: ["ready", "accepted", "rejected", "failed"],
  accepted: ["queued", "failed"],
  rejected: [],
  queued: ["uploading", "failed"],
  uploading: ["queued", "uploaded", "failed"],
  uploaded: [],
  failed: ["ready", "queued"],
});

const UPDATE_FIELDS = Object.freeze({
  checksum: "checksum",
  currentPath: "current_path",
  decision: "decision",
  decisionReason: "decision_reason",
  failureReason: "failure_reason",
  metadataJson: "metadata_json",
  opencvEnabled: "opencv_enabled",
  queuedAt: "queued_at",
  routedAt: "routed_at",
  uploadedAt: "uploaded_at",
});

const SCHEMA_PATH = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const require = createRequire(import.meta.url);
const SQL_WASM_PATH = require.resolve("sql.js/dist/sql-wasm.wasm");

let sqlModulePromise = null;

function nowIso() {
  return new Date().toISOString();
}

function loadSqlModule() {
  sqlModulePromise ??= initSqlJs({
    locateFile: () => SQL_WASM_PATH,
  });

  return sqlModulePromise;
}

function normalizeBoolean(value) {
  return value ? 1 : 0;
}

function serializeJson(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function normalizeClipPath(filePath) {
  return path.normalize(path.resolve(filePath));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function moveFileAcrossDevices(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }

    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
}

async function moveFileToDirectory(sourcePath, targetDirectory) {
  await fs.mkdir(targetDirectory, { recursive: true });

  const parsedPath = path.parse(sourcePath);
  let targetPath = path.join(targetDirectory, parsedPath.base);
  let suffix = 1;

  while (await pathExists(targetPath)) {
    targetPath = path.join(
      targetDirectory,
      `${parsedPath.name}-${suffix}${parsedPath.ext}`,
    );
    suffix += 1;
  }

  await moveFileAcrossDevices(sourcePath, targetPath);

  return normalizeClipPath(targetPath);
}

function normalizeClip(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    sourceCamera: row.sourceCamera,
    originalPath: row.originalPath,
    currentPath: row.currentPath,
    stableAt: row.stableAt,
    status: row.status,
    checksum: row.checksum ?? null,
    sizeBytes: row.sizeBytes ?? null,
    mtimeMs: row.mtimeMs ?? null,
    opencvEnabled: Boolean(row.opencvEnabled),
    decision: row.decision ?? null,
    decisionReason: row.decisionReason ?? null,
    metadata: parseJson(row.metadataJson),
    queuedAt: row.queuedAt ?? null,
    uploadedAt: row.uploadedAt ?? null,
    routedAt: row.routedAt ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeDecisionResult(result, fallbackDecision) {
  return {
    decision: result?.decision ?? fallbackDecision,
    reason: result?.reason ?? null,
    metadata: result?.metadata ?? {},
  };
}

export function assertClipTransition(currentStatus, nextStatus) {
  if (!CLIP_STATES.includes(nextStatus)) {
    throw new Error(`Unknown clip status: ${nextStatus}`);
  }

  const allowedStatuses = ALLOWED_TRANSITIONS[currentStatus] ?? [];

  if (!allowedStatuses.includes(nextStatus)) {
    throw new Error(
      `Cannot transition clip from ${currentStatus} to ${nextStatus}`,
    );
  }
}

export class QueueManager {
  constructor(config, options = {}) {
    this.dbPath = options.dbPath ?? config.paths.dbPath;
    this.schemaPath = options.schemaPath ?? SCHEMA_PATH;
    this.database = null;
  }

  async initialize() {
    const SQL = await loadSqlModule();

    try {
      const bytes = await fs.readFile(this.dbPath);
      this.database = new SQL.Database(bytes);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.database = new SQL.Database();
    }

    const schema = await fs.readFile(this.schemaPath, "utf8");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(schema);
    await this.persist();

    return this;
  }

  ensureOpen() {
    if (!this.database) {
      throw new Error("QueueManager has not been initialized.");
    }
  }

  async close() {
    if (!this.database) {
      return;
    }

    await this.persist();
    this.database.close();
    this.database = null;
  }

  async persist() {
    this.ensureOpen();

    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    const tempPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, Buffer.from(this.database.export()));
    await fs.rename(tempPath, this.dbPath);
  }

  getRows(sql, params = {}) {
    this.ensureOpen();

    const statement = this.database.prepare(sql);
    const rows = [];

    try {
      if (Object.keys(params).length > 0) {
        statement.bind(params);
      }

      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
    } finally {
      statement.free();
    }

    return rows;
  }

  run(sql, params = {}) {
    this.ensureOpen();

    const statement = this.database.prepare(sql);

    try {
      if (Object.keys(params).length > 0) {
        statement.bind(params);
      }

      statement.step();
    } finally {
      statement.free();
    }
  }

  clipSelectSql(whereSql = "") {
    return `
      SELECT
        id,
        source_camera AS sourceCamera,
        original_path AS originalPath,
        current_path AS currentPath,
        stable_at AS stableAt,
        status,
        checksum,
        size_bytes AS sizeBytes,
        mtime_ms AS mtimeMs,
        opencv_enabled AS opencvEnabled,
        decision,
        decision_reason AS decisionReason,
        metadata_json AS metadataJson,
        queued_at AS queuedAt,
        uploaded_at AS uploadedAt,
        routed_at AS routedAt,
        failure_reason AS failureReason,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM clips
      ${whereSql}
    `;
  }

  getClipById(clipId) {
    const [row] = this.getRows(this.clipSelectSql("WHERE id = $id"), {
      $id: clipId,
    });

    return normalizeClip(row);
  }

  getClipByOriginalPath(originalPath) {
    const [row] = this.getRows(
      this.clipSelectSql("WHERE original_path = $originalPath"),
      {
        $originalPath: normalizeClipPath(originalPath),
      },
    );

    return normalizeClip(row);
  }

  listResumableClips() {
    const placeholders = RESUMABLE_CLIP_STATES.map(
      (_status, index) => `$status${index}`,
    );
    const params = Object.fromEntries(
      RESUMABLE_CLIP_STATES.map((status, index) => [`$status${index}`, status]),
    );

    return this.getRows(
      this.clipSelectSql(
        `WHERE status IN (${placeholders.join(", ")}) ORDER BY updated_at ASC`,
      ),
      params,
    ).map(normalizeClip);
  }

  async enqueueClip(event, options = {}) {
    const originalPath = normalizeClipPath(event.originalPath);
    const existingClip = this.getClipByOriginalPath(originalPath);

    if (existingClip) {
      return { clip: existingClip, created: false };
    }

    const createdAt = nowIso();
    const checksum = options.checksum ?? (await hashFile(originalPath));

    this.run(
      `
        INSERT INTO clips (
          source_camera,
          original_path,
          current_path,
          stable_at,
          status,
          checksum,
          size_bytes,
          mtime_ms,
          opencv_enabled,
          created_at,
          updated_at
        ) VALUES (
          $sourceCamera,
          $originalPath,
          $currentPath,
          $stableAt,
          'ready',
          $checksum,
          $sizeBytes,
          $mtimeMs,
          $opencvEnabled,
          $createdAt,
          $updatedAt
        )
      `,
      {
        $sourceCamera: event.sourceCamera,
        $originalPath: originalPath,
        $currentPath: originalPath,
        $stableAt: event.stableAt ?? createdAt,
        $checksum: checksum,
        $sizeBytes: event.sizeBytes ?? null,
        $mtimeMs: event.mtimeMs ?? null,
        $opencvEnabled: normalizeBoolean(options.opencvEnabled),
        $createdAt: createdAt,
        $updatedAt: createdAt,
      },
    );
    await this.persist();

    return { clip: this.getClipByOriginalPath(originalPath), created: true };
  }

  async transitionClip(clipId, nextStatus, updates = {}) {
    const clip = this.getClipById(clipId);

    if (!clip) {
      throw new Error(`Clip not found: ${clipId}`);
    }

    assertClipTransition(clip.status, nextStatus);

    const updatedAt = nowIso();
    const assignments = ["status = $status", "updated_at = $updatedAt"];
    const params = {
      $id: clipId,
      $status: nextStatus,
      $updatedAt: updatedAt,
    };

    Object.entries(updates).forEach(([fieldName, fieldValue], index) => {
      const columnName = UPDATE_FIELDS[fieldName];

      if (!columnName) {
        throw new Error(`Unknown clip update field: ${fieldName}`);
      }

      const paramName = `$field${index}`;
      assignments.push(`${columnName} = ${paramName}`);
      params[paramName] =
        fieldName === "opencvEnabled"
          ? normalizeBoolean(fieldValue)
          : fieldValue;
    });

    this.run(
      `UPDATE clips SET ${assignments.join(", ")} WHERE id = $id`,
      params,
    );
    await this.persist();

    return this.getClipById(clipId);
  }

  async recoverPendingWork() {
    let changed = false;

    this.getRows(this.clipSelectSql("WHERE status = 'processing'")).forEach(
      (row) => {
        const clip = normalizeClip(row);
        this.run(
          "UPDATE clips SET status = 'ready', updated_at = $updatedAt WHERE id = $id",
          {
            $id: clip.id,
            $updatedAt: nowIso(),
          },
        );
        changed = true;
      },
    );

    this.getRows(this.clipSelectSql("WHERE status = 'uploading'")).forEach(
      (row) => {
        const clip = normalizeClip(row);
        this.run(
          "UPDATE clips SET status = 'queued', updated_at = $updatedAt WHERE id = $id",
          {
            $id: clip.id,
            $updatedAt: nowIso(),
          },
        );
        changed = true;
      },
    );

    if (changed) {
      await this.persist();
    }

    return this.listResumableClips();
  }

  async markProcessing(clipId) {
    return this.transitionClip(clipId, "processing");
  }

  async acceptClip(clipId, result = {}) {
    const decision = normalizeDecisionResult(result, "accepted");

    return this.transitionClip(clipId, "accepted", {
      decision: "accepted",
      decisionReason: decision.reason,
      metadataJson: serializeJson(decision.metadata),
    });
  }

  async rejectClip(clipId, result, rejectedDirectory) {
    const clip = this.getClipById(clipId);

    if (!clip) {
      throw new Error(`Clip not found: ${clipId}`);
    }

    const decision = normalizeDecisionResult(result, "rejected");
    const routedPath = await moveFileToDirectory(
      clip.currentPath,
      rejectedDirectory,
    );

    return this.transitionClip(clipId, "rejected", {
      currentPath: routedPath,
      decision: "rejected",
      decisionReason: decision.reason,
      metadataJson: serializeJson(decision.metadata),
      routedAt: nowIso(),
    });
  }

  async failClip(clipId, error) {
    return this.transitionClip(clipId, "failed", {
      failureReason: error instanceof Error ? error.message : String(error),
    });
  }

  async recordUploadAttempt(clipId, attempt) {
    const createdAt = nowIso();

    this.run(
      `
        INSERT INTO upload_attempts (
          clip_id,
          attempt_number,
          response_status,
          error_summary,
          created_at
        ) VALUES ($clipId, $attemptNumber, $responseStatus, $errorSummary, $createdAt)
      `,
      {
        $clipId: clipId,
        $attemptNumber: attempt.attemptNumber,
        $responseStatus: attempt.responseStatus ?? null,
        $errorSummary: attempt.errorSummary ?? null,
        $createdAt: createdAt,
      },
    );
    await this.persist();
  }

  async setRuntimeConfig(key, value) {
    this.run(
      `
        INSERT INTO runtime_config (key, value_json, updated_at)
        VALUES ($key, $valueJson, $updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      {
        $key: key,
        $valueJson: JSON.stringify(value),
        $updatedAt: nowIso(),
      },
    );
    await this.persist();
  }

  getRuntimeConfig(key) {
    const [row] = this.getRows(
      "SELECT value_json AS valueJson FROM runtime_config WHERE key = $key",
      { $key: key },
    );

    return parseJson(row?.valueJson);
  }

  async recordIrrigationEvent(event) {
    this.run(
      `
        INSERT INTO irrigation_events (action, payload_json, result_json, created_at)
        VALUES ($action, $payloadJson, $resultJson, $createdAt)
      `,
      {
        $action: event.action,
        $payloadJson: serializeJson(event.payload),
        $resultJson: serializeJson(event.result),
        $createdAt: nowIso(),
      },
    );
    await this.persist();
  }
}

export async function createQueueManager(config, options = {}) {
  const queueManager = new QueueManager(config, options);

  await queueManager.initialize();

  return queueManager;
}
