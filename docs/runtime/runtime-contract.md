# Animo Bee Runtime Contract

## Summary

The `animo-bee` runtime is now defined by one config surface across development and Raspberry Pi deployment:

- all filesystem paths, feature toggles, and outbound integrations come from env
- motionEye remains native and writes into shared runtime folders
- the Node orchestrator reads those folders, persists queue state in SQLite, and exposes a local control API
- startup always creates the required runtime directories before watcher or queue services begin

This is the only approved source for runtime paths, queue persistence, upload behavior, irrigation behavior, OpenCV worker settings, and API host or port settings.

## Supported Profiles

### Profile 1: Development

Default values come from `.env.example`:

| Env Key                   | Default Value                      | Meaning                                      |
| ------------------------- | ---------------------------------- | -------------------------------------------- |
| `APP_MODE`                | `development`                      | Development runtime mode                     |
| `HOST`                    | `0.0.0.0`                          | HTTP bind host                               |
| `PORT`                    | `3001`                             | Local API port                               |
| `CAMERA_1_DIR`            | `./runtime/camera_1`               | Camera input directory 1                     |
| `CAMERA_2_DIR`            | `./runtime/camera_2`               | Camera input directory 2                     |
| `PROCESSED_DIR`           | `./runtime/processed`              | Accepted and uploaded clip output            |
| `REJECTED_DIR`            | `./runtime/rejected`               | Rejected clip output                         |
| `DB_PATH`                 | `./runtime/db/orchestrator.sqlite` | SQLite database path                         |
| `LOG_DIR`                 | `./runtime/logs`                   | Runtime log directory                        |
| `OPENCV_ENABLED`          | `false`                            | Optional decision-layer feature toggle       |
| `OPENCV_WORKER_COMMAND`   | empty                              | Child-process worker command                 |
| `OPENCV_WORKER_ARGS`      | `[]`                               | JSON string array of process args            |
| `OPENCV_WORKER_URL`       | empty                              | HTTP worker endpoint                         |
| `OPENCV_TIMEOUT_MS`       | `30000`                            | OpenCV worker timeout                        |
| `UPLOAD_ENABLED`          | `false`                            | Sequential upload worker feature toggle      |
| `UPLOAD_URL`              | empty                              | Upstream upload endpoint                     |
| `UPLOAD_HEADERS_JSON`     | `{}`                               | JSON object of extra upload headers          |
| `UPLOAD_MAX_ATTEMPTS`     | `3`                                | Retry ceiling before a clip becomes `failed` |
| `UPLOAD_POLL_INTERVAL_MS` | `5000`                             | Upload poll cadence                          |
| `UPLOAD_RETRY_DELAY_MS`   | `30000`                            | Delay before a queued retry                  |
| `UPLOAD_TIMEOUT_MS`       | `60000`                            | Upload request timeout                       |
| `IRRIGATION_ENABLED`      | `false`                            | Irrigation control feature toggle            |
| `IRRIGATION_TRIGGER_URL`  | empty                              | Irrigation HTTP endpoint                     |
| `IRRIGATION_HEADERS_JSON` | `{}`                               | JSON object of extra irrigation headers      |
| `IRRIGATION_TIMEOUT_MS`   | `10000`                            | Irrigation request timeout                   |

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

`docker-compose.prod.yml` is required to forward the upload, irrigation, and OpenCV worker env surface into the app container. If those keys are missing in the container, the runtime is misconfigured even if the process is healthy.

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

- `PORT` and all timeout or retry values must parse to positive integers
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
- `upload_attempts` stores retry history and HTTP outcomes
- `runtime_config` stores persisted runtime toggles such as `opencvEnabled`
- `irrigation_events` stores irrigation request and result payloads

Startup recovery must reset orphaned `processing` records to `ready` and orphaned `uploading` records to `queued` before new watcher events are consumed.

## Local API Contract

The local API surface exposed by `src/api/server.js` is:

- `GET /health` - runtime summary with queue, upload worker, and irrigation status
- `GET /` - minimal process-running message
- `GET /queue` - queue summary and recent clips
- `GET /queue/:clipId` - one clip plus upload attempt history
- `POST /config/opencv` - persist the runtime OpenCV toggle
- `POST /uploads/retry/:clipId` - requeue a failed upload
- `POST /irrigation/trigger` - forward one irrigation action through the controller boundary

All successful responses are wrapped in `{ data: ... }`.

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
- exports `ANIMO_BEE_RUNTIME_ROOT`, `ANIMO_BEE_APP_PORT`, and `ANIMO_BEE_OPENCV_ENABLED`
- validates the compose render before `up -d`
- supports `--with-opencv` and `--no-build`

`scripts/prod/healthcheck.sh` is the required semantic smoke test after startup.

## Constraints

- motionEye stays outside Docker and is not configured by the orchestrator scripts
- the first production version uploads one clip at a time on purpose
- the optional OpenCV path is only valid when `OPENCV_WORKER_URL` or `OPENCV_WORKER_COMMAND` is configured
- deployment sign-off still requires a real device run using `tests/integration/verify-runtime.md`
