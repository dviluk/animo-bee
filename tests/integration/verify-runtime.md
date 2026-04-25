# Runtime Verification Guide

This guide provides the repeatable Phase 5 verification path for the Raspberry Pi runtime.

## Goal

Prove the full path from motionEye-style clip arrival to queue persistence, upload handling, API visibility, retry recovery, and irrigation logging.

## Prerequisites

- Repository available at `/data/projects/animo-animo/animo-bee`
- Native motionEye installed and writing to the configured runtime root
- Docker, Docker Compose, `sqlite3`, and `python3` available on the Pi
- `.env.prod` prepared
- A short known-good `.mp4` clip kept outside the live runtime as a fixture, for example `/tmp/animo-bee-fixtures/verify-clip.mp4`

## 1) Validate the host and runtime layout

```bash
cd /data/projects/animo-animo/animo-bee
./scripts/prod/bootstrap-native.sh
./scripts/prod/create-runtime-layout.sh
```

Expected:

- motionEye is detected
- runtime directories exist and are writable
- `db/orchestrator.sqlite` exists

## 2) Point `.env.prod` at deterministic local stubs

For a repeatable verification run, use local upload and irrigation stubs instead of production-only upstreams.

Example `.env.prod` values:

```dotenv
APP_MODE=production
PORT=3001
UPLOAD_ENABLED=true
UPLOAD_URL=http://127.0.0.1:9090/upload
UPLOAD_HEADERS_JSON={}
IRRIGATION_ENABLED=true
IRRIGATION_TRIGGER_URL=http://127.0.0.1:9091/trigger
IRRIGATION_HEADERS_JSON={}
```

## 3) Start the upload stub

Run in a dedicated terminal:

```bash
mkdir -p /tmp/animo-bee-upload-captures
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

root = Path('/tmp/animo-bee-upload-captures')
root.mkdir(parents=True, exist_ok=True)

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(size)
        clip_id = self.headers.get('x-animo-clip-id', 'unknown')
        (root / f'{clip_id}.bin').write_bytes(body)
        self.send_response(201)
        self.end_headers()
        self.wfile.write(b'uploaded')

    def log_message(self, *_args):
        return

HTTPServer(('127.0.0.1', 9090), Handler).serve_forever()
PY
```

Expected:

- the stub remains running and accepts POST requests on port `9090`

## 4) Start the irrigation stub

Run in another dedicated terminal:

```bash
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

log_path = Path('/tmp/animo-bee-irrigation.log')

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(size)
        with log_path.open('ab') as handle:
            handle.write(body + b'\n')
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b'accepted')

    def log_message(self, *_args):
        return

HTTPServer(('127.0.0.1', 9091), Handler).serve_forever()
PY
```

Expected:

- the stub remains running and appends requests to `/tmp/animo-bee-irrigation.log`

## 5) Start the hybrid runtime and confirm health

```bash
cd /data/projects/animo-animo/animo-bee
./scripts/prod/start-prod-stack.sh --no-build
./scripts/prod/healthcheck.sh
curl -s http://127.0.0.1:3001/health | jq
curl -s http://127.0.0.1:3001/queue | jq
```

Expected:

- `healthcheck.sh` exits `0`
- `/health` contains `data.queue`, `data.upload`, and `data.irrigation`
- `/queue` returns `data.summary` and `data.clips`

## 6) Verify the upload success path with a fixture clip

```bash
export FIXTURE_CLIP=/tmp/animo-bee-fixtures/verify-clip.mp4
export RUNTIME_ROOT=/mnt/bee-disk/projects/animo-bee
test -f "$FIXTURE_CLIP"

STAMP=$(date +%s)
TARGET_CLIP="$RUNTIME_ROOT/data/camera_1/verify-$STAMP.mp4"
cp "$FIXTURE_CLIP" "$TARGET_CLIP"

curl -s http://127.0.0.1:3001/queue?limit=5 | jq
sqlite3 "$RUNTIME_ROOT/db/orchestrator.sqlite" 'select id, status, source_camera, current_path from clips order by id desc limit 5;'
sqlite3 "$RUNTIME_ROOT/db/orchestrator.sqlite" 'select clip_id, attempt_number, response_status, error_summary from upload_attempts order by id desc limit 5;'
ls -l "$RUNTIME_ROOT/data/processed"
ls -l /tmp/animo-bee-upload-captures
```

Expected:

- a new clip record appears in SQLite
- the clip reaches `uploaded`
- one upload attempt is recorded with a `201` response
- the file moves into `data/processed`
- the upload stub writes a captured payload file

## 7) Verify the failure and retry path

First, stop the upload stub from Step 3. Then copy the fixture again:

```bash
STAMP=$(date +%s)
TARGET_CLIP="$RUNTIME_ROOT/data/camera_1/retry-$STAMP.mp4"
cp "$FIXTURE_CLIP" "$TARGET_CLIP"

curl -s http://127.0.0.1:3001/queue?limit=5 | jq
sqlite3 "$RUNTIME_ROOT/db/orchestrator.sqlite" 'select id, status, failure_reason from clips order by id desc limit 5;'
```

Expected after retries are exhausted:

- the clip reaches `failed`
- `upload_attempts` records multiple attempts with connection failures

Restart the upload stub, identify the failed clip ID, and retry it:

```bash
FAILED_CLIP_ID=$(sqlite3 "$RUNTIME_ROOT/db/orchestrator.sqlite" 'select id from clips where status = "failed" order by id desc limit 1;')
curl -s -X POST "http://127.0.0.1:3001/uploads/retry/$FAILED_CLIP_ID" | jq
curl -s "http://127.0.0.1:3001/queue/$FAILED_CLIP_ID" | jq
```

Expected:

- the retry endpoint returns the clip back in `queued`
- the worker uploads it successfully on the next pass
- the clip eventually moves to `uploaded`

## 8) Verify irrigation logging

```bash
curl -s -X POST http://127.0.0.1:3001/irrigation/trigger \
  -H 'content-type: application/json' \
  -d '{"action":"zone-test","payload":{"zone":1,"durationSeconds":2}}' | jq

sqlite3 "$RUNTIME_ROOT/db/orchestrator.sqlite" 'select id, action, result_json from irrigation_events order by id desc limit 5;'
tail -n 5 /tmp/animo-bee-irrigation.log
```

Expected:

- the API responds with `ok: true`
- a new `irrigation_events` row is recorded
- the irrigation stub log contains the JSON request payload

## 9) Stop the runtime cleanly

```bash
cd /data/projects/animo-animo/animo-bee
./scripts/prod/stop-prod-stack.sh
```

Expected:

- containers stop without orphaned services
- the database and processed files remain on disk

## Completion Checklist

- [ ] Healthcheck passes with semantic queue and upload validation
- [ ] A fixture clip uploads successfully and lands in `processed`
- [ ] A forced upload failure can be retried through the local API
- [ ] Irrigation calls are logged in SQLite and visible in the stub log
- [ ] The stack stops cleanly without losing runtime state
