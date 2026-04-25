#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

mkdir -p \
  runtime/camera_1 \
  runtime/camera_2 \
  runtime/processed \
  runtime/rejected \
  runtime/db \
  runtime/logs

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

printf 'Native camera software should write clips into:\n'
printf '  %s\n' "$project_root/runtime/camera_1"
printf '  %s\n' "$project_root/runtime/camera_2"
echo 'IMPORTANT: Ensure native motionEye is started on the host BEFORE running this Dockerized orchestrator.'
echo 'Run: ./scripts/dev/start-motion-host.sh (Start motionEye on the host)'
echo 'This command attaches to container logs. Press Ctrl+C to stop the Docker stack.'
echo '----------------------------------------------------------------------'

docker compose --env-file .env -f docker-compose.dev.yml up --build