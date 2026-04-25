# Raspberry Pi Deployment Guide (Phase 3)

This guide documents the native provisioning scripts added for the hybrid runtime.

## Runtime Boundary

- motionEye remains native on the Pi.
- animo-bee orchestration services run in containers.
- Shared runtime storage is rooted at `/mnt/bee-disk/projects/animo-bee`.

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

## 2) Create Runtime Layout

```bash
./scripts/prod/create-runtime-layout.sh
```

Default layout created:

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

## 3) Run Healthcheck

```bash
./scripts/prod/healthcheck.sh
```

What it checks:

- runtime directory and SQLite path presence
- SQLite integrity (`PRAGMA quick_check` when available)
- motionEye service or process presence
- Docker Compose availability
- local app health endpoint (default `http://127.0.0.1:3001/health`)

Supported overrides:

- `ANIMO_BEE_RUNTIME_ROOT`
- `ANIMO_BEE_DB_PATH`
- `ANIMO_BEE_PROD_COMPOSE_FILE`
- `ANIMO_BEE_HEALTH_URL`

## 4) Start Production Stack

Run from the repository root:

```bash
./scripts/prod/start-prod-stack.sh
```

Optional flags:

- `--with-opencv` enables the optional OpenCV worker profile.
- `--no-build` skips image rebuild and starts with existing images.

Examples:

```bash
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

## 5) Stop Production Stack

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

## Notes

- These scripts do not configure motionEye; they only validate its presence and status.
- Production compose wrappers keep motionEye native and run only the orchestrator services in containers.
