# Raspberry Pi Deployment Guide

This is the operator-facing rollout guide for the hybrid `animo-bee` runtime.

## Runtime Boundary

- motionEye remains native on the Raspberry Pi and writes clips into shared runtime folders.
- `animo-bee` runs in Docker and reads those clips from the mounted runtime root.
- The default runtime root is `/mnt/bee-disk/projects/animo-bee`.
- Upload, irrigation, and optional OpenCV worker settings come from `.env.prod` and are forwarded into the app container.

## 1) Validate Native Prerequisites

Run from the repository root:

```bash
./scripts/prod/bootstrap-native.sh
```

Optional install mode for missing packages:

```bash
sudo ./scripts/prod/bootstrap-native.sh --install
```

What it validates:

- Debian-family host
- Native tooling (`curl`, `git`, `sqlite3`, `docker`, Docker Compose)
- motionEye presence and runtime status
- storage anchor availability at `/mnt/bee-disk`

## 2) Create the Runtime Layout

```bash
./scripts/prod/create-runtime-layout.sh
```

Default layout:

- `/mnt/bee-disk/projects/animo-bee/data/camera_1`
- `/mnt/bee-disk/projects/animo-bee/data/camera_2`
- `/mnt/bee-disk/projects/animo-bee/data/processed`
- `/mnt/bee-disk/projects/animo-bee/data/rejected`
- `/mnt/bee-disk/projects/animo-bee/logs`
- `/mnt/bee-disk/projects/animo-bee/db/orchestrator.sqlite`

Supported overrides:

- `ANIMO_BEE_RUNTIME_ROOT`
- `ANIMO_BEE_DB_FILE`
- `ANIMO_BEE_OWNER`
- `ANIMO_BEE_GROUP`
- `ANIMO_BEE_SKIP_MOUNT_CHECK=1`

## 3) Prepare `.env.prod`

Create `.env.prod` in the repository root. Start from `.env.example`, then set production values explicitly.

Minimum example:

```dotenv
APP_MODE=production
HOST=0.0.0.0
PORT=3001

CAMERA_1_DIR=/app/runtime/camera_1
CAMERA_2_DIR=/app/runtime/camera_2
PROCESSED_DIR=/app/runtime/processed
REJECTED_DIR=/app/runtime/rejected
DB_PATH=/app/runtime/db/orchestrator.sqlite
LOG_DIR=/app/runtime/logs

UPLOAD_ENABLED=true
UPLOAD_URL=http://127.0.0.1:9090/upload
UPLOAD_HEADERS_JSON={}

IRRIGATION_ENABLED=true
IRRIGATION_TRIGGER_URL=http://127.0.0.1:9091/trigger
IRRIGATION_HEADERS_JSON={}

OPENCV_WORKER_URL=
OPENCV_WORKER_COMMAND=
OPENCV_WORKER_ARGS=[]
```

Important notes:

- `start-prod-stack.sh` resolves `.env.prod` automatically unless `ANIMO_BEE_ENV_FILE` overrides it.
- `--with-opencv` only enables the OpenCV feature flag and the optional profile. It does not create a worker contract by itself. Set `OPENCV_WORKER_URL` or `OPENCV_WORKER_COMMAND` if you want real OpenCV decisions.
- The app container now receives the full upload, irrigation, and OpenCV worker env surface from `docker-compose.prod.yml`.

## 4) Start the Production Stack

```bash
./scripts/prod/start-prod-stack.sh
```

Optional flags:

- `--with-opencv` enables the optional OpenCV profile.
- `--no-build` skips image rebuild and starts with existing images.

Examples:

```bash
./scripts/prod/start-prod-stack.sh --no-build
./scripts/prod/start-prod-stack.sh --with-opencv
./scripts/prod/start-prod-stack.sh --with-opencv --no-build
```

Supported overrides:

- `ANIMO_BEE_PROD_COMPOSE_FILE`
- `ANIMO_BEE_ENV_FILE`
- `ANIMO_BEE_RUNTIME_ROOT`
- `ANIMO_BEE_APP_PORT`
- `ANIMO_BEE_OPENCV_ENABLED`
- `ANIMO_BEE_COMPOSE_PROJECT`

## 5) Verify the Deployment

Run the production healthcheck first:

```bash
./scripts/prod/healthcheck.sh
curl -s http://127.0.0.1:3001/health | jq
curl -s http://127.0.0.1:3001/queue | jq
```

What the healthcheck validates:

- runtime directory existence and writability
- SQLite integrity plus required tables (`clips`, `upload_attempts`, `runtime_config`, `irrigation_events`)
- motionEye service or process presence
- Docker Compose rendering
- local `/health` payload semantics
- local `/queue` payload shape

For the full motionEye -> watcher -> queue -> upload -> irrigation path, run:

- `tests/integration/verify-runtime.md`

## 6) Stop the Production Stack

```bash
./scripts/prod/stop-prod-stack.sh
```

Optional cleanup:

```bash
./scripts/prod/stop-prod-stack.sh --volumes
```

Supported overrides:

- `ANIMO_BEE_PROD_COMPOSE_FILE`
- `ANIMO_BEE_ENV_FILE`
- `ANIMO_BEE_COMPOSE_PROJECT`

## 7) Roll Back

The runtime is small enough that rollback should be explicit and boring:

1. Stop the current stack with `./scripts/prod/stop-prod-stack.sh`.
2. Restore the previously known-good application revision or image.
3. Restore the previous `.env.prod` if the deploy changed runtime URLs, headers, or feature flags.
4. Start the stack again with `./scripts/prod/start-prod-stack.sh --no-build` if the image already exists.
5. Re-run `./scripts/prod/healthcheck.sh` and the smoke steps from `tests/integration/verify-runtime.md`.

Do not treat rollback as complete until `/health` and `/queue` are green again.

## 8) Troubleshooting

### Healthcheck fails on runtime paths

- Verify `ANIMO_BEE_RUNTIME_ROOT` points at the mounted storage anchor.
- Confirm the Pi user or Docker runtime has write access to `data/`, `db/`, and `logs/`.

### `/health` shows `upload.configured=false` or `irrigation.configured=false`

- Check `.env.prod` for the missing URLs.
- Confirm the values are visible inside the container:

```bash
docker compose --env-file .env.prod -p animo-bee-prod -f docker-compose.prod.yml exec app env | grep -E 'UPLOAD_|IRRIGATION_|OPENCV_'
```

### Clips stay in `failed`

- Inspect upload attempt history:

```bash
sqlite3 /mnt/bee-disk/projects/animo-bee/db/orchestrator.sqlite 'select clip_id, attempt_number, response_status, error_summary from upload_attempts order by id desc limit 10;'
```

- Fix the upstream URL or headers, then use `POST /uploads/retry/:clipId`.

### `--with-opencv` is enabled but clip decisions fail immediately

- Set `OPENCV_WORKER_URL` or `OPENCV_WORKER_COMMAND`.
- The optional `opencv-worker` profile is not a substitute for the worker contract the app expects.

### Queue looks healthy but upload behavior is unclear

- Query one clip directly:

```bash
curl -s http://127.0.0.1:3001/queue/1 | jq
```

- Inspect `lastResult`, `lastError`, and `inFlightClipId` in `/health`.
