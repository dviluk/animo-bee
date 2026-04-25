# Animo Bee Runtime Contract

## Summary

The `animo-bee` runtime is defined by one config surface across development and Raspberry Pi deployment:

- all filesystem paths, feature toggles, and outbound integrations come from env
- motionEye remains native and writes into shared runtime folders
- the Node orchestrator reads those folders, persists queue state in SQLite, and exposes a local control API
- startup always creates the required runtime directories before watcher or queue services begin

This document is the source of truth for runtime paths, queue persistence, upload behavior, irrigation behavior, OpenCV mode contracts, and API settings.

## Supported Profiles

### Profile 1: Development

Default values come from `.env.example`:

| Env Key                         | Default Value                      | Meaning                                                          |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `APP_MODE`                      | `development`                      | Development runtime mode                                         |
| `HOST`                          | `0.0.0.0`                          | HTTP bind host                                                   |
| `PORT`                          | `3001`                             | Local API port                                                   |
| `CAMERA_1_DIR`                  | `./runtime/camera_1`               | Camera input directory 1                                         |
| `CAMERA_2_DIR`                  | `./runtime/camera_2`               | Camera input directory 2                                         |
| `PROCESSED_DIR`                 | `./runtime/processed`              | Accepted and uploaded clip output                                |
| `REJECTED_DIR`                  | `./runtime/rejected`               | Rejected clip output                                             |
| `DB_PATH`                       | `./runtime/db/orchestrator.sqlite` | SQLite database path                                             |
| `LOG_DIR`                       | `./runtime/logs`                   | Runtime log directory                                            |
| `OPENCV_ENABLED`                | `false`                            | Legacy compatibility toggle; `true` maps to mode `shadow`        |
| `OPENCV_MODE`                   | `disabled`                         | OpenCV runtime mode: `disabled`, `shadow`, or `enforce`          |
| `OPENCV_FAIL_OPEN`              | `true`                             | Queue clip on worker failures instead of failing clip processing |
| `OPENCV_RETAIN_REJECTED_FILES`  | `true`                             | Keep rejected clips in rejected archive when enforcement rejects |
| `OPENCV_ROI_CONFIG_PATH`        | `./config/opencv-roi.example.json` | Per-camera ROI and threshold config path                         |
| `OPENCV_MIN_MOTION_DURATION_MS` | `500`                              | Minimum motion duration threshold                                |
| `OPENCV_MAX_BRIGHTNESS_CHANGE`  | `0.25`                             | Maximum brightness delta threshold                               |
| `OPENCV_MIN_ROI_MOTION_SCORE`   | `0.4`                              | Minimum ROI motion score threshold                               |
| `OPENCV_WORKER_COMMAND`         | empty                              | Child-process worker command                                     |
| `OPENCV_WORKER_ARGS`            | `[]`                               | JSON string array of process args                                |
| `OPENCV_WORKER_URL`             | empty                              | HTTP worker endpoint                                             |
| `OPENCV_TIMEOUT_MS`             | `30000`                            | OpenCV worker timeout                                            |
| `UPLOAD_ENABLED`                | `false`                            | Sequential upload worker feature toggle                          |
| `UPLOAD_URL`                    | empty                              | Upstream upload endpoint                                         |
| `UPLOAD_HEADERS_JSON`           | `{}`                               | JSON object of extra upload headers                              |
| `UPLOAD_MAX_ATTEMPTS`           | `3`                                | Retry ceiling before a clip becomes `failed`                     |
| `UPLOAD_POLL_INTERVAL_MS`       | `5000`                             | Upload poll cadence                                              |
| `UPLOAD_RETRY_DELAY_MS`         | `30000`                            | Delay before a queued retry                                      |
| `UPLOAD_TIMEOUT_MS`             | `60000`                            | Upload request timeout                                           |
| `IRRIGATION_ENABLED`            | `false`                            | Irrigation control feature toggle                                |
| `IRRIGATION_TRIGGER_URL`        | empty                              | Irrigation HTTP endpoint                                         |
| `IRRIGATION_HEADERS_JSON`       | `{}`                               | JSON object of extra irrigation headers                          |
| `IRRIGATION_TIMEOUT_MS`         | `10000`                            | Irrigation request timeout                                       |

When the dev stack runs in Docker, `docker-compose.dev.yml` bind-mounts the full repository as `.:/app/`. That means the default relative runtime paths resolve inside the container as:

- `/app/runtime/camera_1`
- `/app/runtime/camera_2`
- `/app/runtime/processed`
- `/app/runtime/rejected`
- `/app/runtime/db/orchestrator.sqlite`
- `/app/runtime/logs`

### Profile 2: Raspberry Pi Production Contract

Production uses the same normalized config shape, but the compose wrapper maps the host runtime root into `/app/runtime/*` inside the container.

Host layout defaults:

| Host Path                                                 | Purpose                   |
| --------------------------------------------------------- | ------------------------- |
| `/mnt/bee-disk/projects/animo-bee/data/camera_1`          | motionEye camera output 1 |
| `/mnt/bee-disk/projects/animo-bee/data/camera_2`          | motionEye camera output 2 |
| `/mnt/bee-disk/projects/animo-bee/data/processed`         | Uploaded clip archive     |
| `/mnt/bee-disk/projects/animo-bee/data/rejected`          | Rejected clip archive     |
| `/mnt/bee-disk/projects/animo-bee/db/orchestrator.sqlite` | SQLite queue database     |
| `/mnt/bee-disk/projects/animo-bee/logs`                   | Runtime logs              |

Container layout defaults:

| Container Path                        | Purpose               |
| ------------------------------------- | --------------------- |
| `/app/runtime/camera_1`               | Camera input 1        |
| `/app/runtime/camera_2`               | Camera input 2        |
| `/app/runtime/processed`              | Uploaded clip archive |
| `/app/runtime/rejected`               | Rejected clip archive |
| `/app/runtime/db/orchestrator.sqlite` | SQLite queue database |
| `/app/runtime/logs`                   | Runtime logs          |

`docker-compose.prod.yml` must forward upload, irrigation, and OpenCV runtime keys into the app container. If those keys are missing in-container, runtime semantics are invalid even if the process is healthy.

## OpenCV Runtime Modes

Phase 6 establishes mode semantics without claiming real OpenCV analysis has shipped.

| Mode       | Intake Behavior     | Worker Invocation                 | Routing Rule                                                    |
| ---------- | ------------------- | --------------------------------- | --------------------------------------------------------------- |
| `disabled` | Upload-all baseline | Bypassed                          | Clip is accepted and queued with `opencv_status=skipped`        |
| `shadow`   | Upload-all baseline | Enabled when worker is configured | Decisions are persisted, but clips continue through upload path |
| `enforce`  | Decision-aware      | Enabled when worker is configured | Explicit OpenCV `reject` routes clip to rejected handling       |

Fallback behavior:

- If only legacy `OPENCV_ENABLED=true` is provided, runtime mode resolves to `shadow`.
- `failOpen=true` keeps worker errors from dropping clip intake.
- `retainRejectedFiles=true` keeps rejected files in archive instead of deleting them.

## Normalized Config Shape

`src/config/index.js` resolves the runtime contract into this shape:

```js
{
  mode,
  server: {
    host,
    port,
  },
  paths: {
    cameraSources: [camera1, camera2],
    processedDir,
    rejectedDir,
    dbPath,
    logDir,
  },
  features: {
    opencvEnabled,
    uploadEnabled,
    irrigationEnabled,
  },
  opencv: {
    enabled,
    mode,
    failOpen,
    retainRejectedFiles,
    roiConfigPath,
    minMotionDurationMs,
    maxBrightnessChange,
    minRoiMotionScore,
    workerCommand,
    workerArgs,
    workerUrl,
    timeoutMs,
  },
  upload: {
    enabled,
    url,
    headers,
    maxAttempts,
    pollIntervalMs,
    retryDelayMs,
    timeoutMs,
  },
  irrigation: {
    enabled,
    triggerUrl,
    headers,
    timeoutMs,
  },
}
```

Rules enforced by the loader:

- `OPENCV_MODE` must be `disabled`, `shadow`, or `enforce`
- `PORT` and all timeout or retry values must parse to positive integers
- OpenCV thresholds must parse to valid numeric values
- `UPLOAD_HEADERS_JSON` and `IRRIGATION_HEADERS_JSON` must be JSON objects with string values
- `OPENCV_WORKER_ARGS` must be a JSON string array
- every runtime path must be present
- relative paths resolve against the current working directory
- absolute paths are normalized and preserved

## Runtime Directory Guarantees

Before the server starts, `ensureRuntimeDirectories(config)` creates:

- every configured camera source directory
- the processed directory
- the rejected directory
- the log directory
- the parent directory of `DB_PATH`

This guarantees the watcher, queue manager, upload worker, and irrigation controller can assume the runtime layout already exists.

## Queue and Persistence Contract

The SQLite schema is fixed by `src/db/schema.sql`:

- `clips` stores the durable clip lifecycle across `detected`, `ready`, `processing`, `accepted`, `rejected`, `queued`, `uploading`, `uploaded`, and `failed`
- `clips` also stores additive OpenCV contract fields: `opencv_mode`, `opencv_status`, `opencv_decision`, `opencv_reason`, `opencv_scores_json`, `opencv_error`, `opencv_processed_at`
- `upload_attempts` stores retry history and HTTP outcomes
- `runtime_config` stores persisted OpenCV runtime values (`mode`, `enabled`, `failOpen`, retention, thresholds)
- `irrigation_events` stores irrigation request and result payloads

OpenCV decision contract is normalized to:

- `opencv_decision`: `accept`, `reject`, `maybe`
- queue route decision remains `accepted` or `rejected`

Compatibility rule:

- Existing SQLite files are upgraded in-place through additive compatibility columns at QueueManager initialization.

Startup recovery must reset orphaned `processing` records to `ready` and orphaned `uploading` records to `queued` before new watcher events are consumed.

## Local API Contract

The local API surface exposed by `src/api/server.js` is:

- `GET /health` - runtime summary with queue, upload worker, irrigation status, and semantic OpenCV runtime object
- `GET /` - minimal process-running message
- `GET /queue` - queue summary and recent clips
- `GET /queue/:clipId` - one clip plus upload attempt history
- `POST /config/opencv` - persist OpenCV runtime settings (legacy boolean payload still supported)
- `POST /uploads/retry/:clipId` - requeue a failed upload
- `POST /irrigation/trigger` - forward one irrigation action through the controller boundary

All successful responses are wrapped in `{ data: ... }`.

`GET /health` response requirements:

- `data.opencvEnabled` reflects effective mode (`false` only in `disabled` mode)
- `data.opencv` includes `mode`, `enabled`, `failOpen`, `retainRejectedFiles`, thresholds, and `workerConfigured`

## Development and Production Helper Contracts

### Development

`docker-compose.dev.yml` is the source of truth for local parity:

- builds from `Dockerfile`
- runs `npm run dev`
- loads `.env` when present and falls back to `.env.example`
- binds `3001:3001`
- mounts the full repository as `.:/app/`
- exposes a health check against `http://localhost:${PORT:-3001}/health`

### Production

`scripts/prod/start-prod-stack.sh` is the supported entrypoint for the Pi runtime:

- resolves `.env.prod`, `.env`, or `.env.example`
- sources the env file into the parent shell before Docker invocation
- validates `OPENCV_MODE` and ensures non-disabled modes have worker command or URL configured
- exports `ANIMO_BEE_RUNTIME_ROOT`, `ANIMO_BEE_APP_PORT`, `ANIMO_BEE_OPENCV_ENABLED`, and `OPENCV_MODE`
- validates the compose render before `up -d`
- supports `--with-opencv` (promotes mode to `shadow` when needed) and `--no-build`

`scripts/prod/healthcheck.sh` is the required semantic smoke test after startup.

Required `healthcheck.sh` assertions include:

- runtime directories and SQLite artifacts are present and writable
- OpenCV mode is valid (`disabled|shadow|enforce`)
- `/health` includes OpenCV runtime block and expected `mode` / `enabled` pairing
- `/health` includes `failOpen` and `retainRejectedFiles`
- `/queue` includes queue summary and clip list payload shape

## Constraints

- motionEye stays outside Docker and is not configured by the orchestrator scripts
- the first production version uploads one clip at a time on purpose
- the placeholder `src/opencv-worker.js` is not real OpenCV clip analysis
- disabled mode remains the baseline behavior until Phase 7 ships real validator logic
- non-disabled OpenCV modes are valid only when `OPENCV_WORKER_URL` or `OPENCV_WORKER_COMMAND` is configured
- deployment sign-off still requires a real device run using `tests/integration/verify-runtime.md`
