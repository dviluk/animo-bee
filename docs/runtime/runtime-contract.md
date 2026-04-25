# Animo Bee Runtime Contract

## Summary

Phase 2 establishes one runtime contract for the `animo-bee` scaffold:

- the app reads every path and feature toggle from env
- development defaults use repo-local `runtime/*` folders
- the same config layer can resolve absolute Raspberry Pi paths without changing service code
- the scaffold creates required runtime directories before the server starts

This contract is the only approved source for camera input directories, processed or rejected output directories, SQLite location, logs, host and port, and the optional OpenCV flag.

## Supported Profiles

### Profile 1: Development

Default values come from `.env.example`:

| Env Key          | Default Value                      | Resolved Runtime Meaning                              |
| ---------------- | ---------------------------------- | ----------------------------------------------------- |
| `APP_MODE`       | `development`                      | Marks the scaffold as running in development mode     |
| `HOST`           | `0.0.0.0`                          | Binds the HTTP server inside the container            |
| `PORT`           | `3001`                             | Exposes the health and scaffold endpoints             |
| `CAMERA_1_DIR`   | `./runtime/camera_1`               | Camera input directory 1                              |
| `CAMERA_2_DIR`   | `./runtime/camera_2`               | Camera input directory 2                              |
| `PROCESSED_DIR`  | `./runtime/processed`              | Accepted clip output directory                        |
| `REJECTED_DIR`   | `./runtime/rejected`               | Rejected clip output directory                        |
| `DB_PATH`        | `./runtime/db/orchestrator.sqlite` | SQLite file path                                      |
| `LOG_DIR`        | `./runtime/logs`                   | Runtime log directory                                 |
| `OPENCV_ENABLED` | `false`                            | Optional feature toggle for later classification work |

When the dev stack runs in Docker, `docker-compose.dev.yml` mounts `./runtime` to `/app/runtime`, so the resolved in-container paths become:

- `/app/runtime/camera_1`
- `/app/runtime/camera_2`
- `/app/runtime/processed`
- `/app/runtime/rejected`
- `/app/runtime/db/orchestrator.sqlite`
- `/app/runtime/logs`

## Profile 2: Raspberry Pi Production Contract

The config loader also accepts absolute paths for the Pi runtime. Phase 3 will wire the final launch assets around these values.

| Env Key         | Raspberry Pi Value                                        |
| --------------- | --------------------------------------------------------- |
| `CAMERA_1_DIR`  | `/mnt/bee-disk/projects/animo-bee/data/camera_1`          |
| `CAMERA_2_DIR`  | `/mnt/bee-disk/projects/animo-bee/data/camera_2`          |
| `PROCESSED_DIR` | `/mnt/bee-disk/projects/animo-bee/data/processed`         |
| `REJECTED_DIR`  | `/mnt/bee-disk/projects/animo-bee/data/rejected`          |
| `DB_PATH`       | `/mnt/bee-disk/projects/animo-bee/db/orchestrator.sqlite` |
| `LOG_DIR`       | `/mnt/bee-disk/projects/animo-bee/logs`                   |

The service code must keep using the normalized config object. It must not branch on host-specific hard-coded paths.

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
  },
}
```

Rules enforced by the loader:

- `PORT` must parse to a positive integer
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

This means later watcher, queue, and upload services can assume these directories already exist.

## Docker Development Contract

`docker-compose.dev.yml` is the Phase 2 source of truth for development runtime behavior:

- builds the app from `Dockerfile`
- runs `npm run dev`
- loads `.env` when present and falls back to `.env.example`
- binds `3001:3001`
- mounts `./src` for live code edits
- mounts `./runtime` for persistent dev data
- exposes a health check against `http://localhost:${PORT:-3001}/health`

`scripts/dev/start-dev.sh` is the supported helper for local startup. It creates the runtime folders, seeds `.env` from `.env.example` when needed, prints the camera output targets, and launches the compose stack.

## HTTP Contract in Phase 2

The scaffold currently exposes:

- `GET /health` — runtime summary with mode, host, port, OpenCV flag, and resolved camera source paths
- `GET /` — minimal scaffold-running message

The health response is the required smoke-test surface for this phase.

## Constraints

- Motion-driven clip generation stays outside the orchestrator in this phase.
- The dev stack simulates recorder output through mounted directories; it does not containerize the recorder.
- Production compose and Pi bootstrap scripts are Phase 3 work.
