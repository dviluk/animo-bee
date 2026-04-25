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
printf '\nIMPORTANT: Ensure native Motion is started on the host BEFORE running this Dockerized orchestrator.\n'
printf 'Run: ./scripts/dev/start-motion-host.sh (Start Motion service natively)\n'
printf '----------------------------------------------------------------------\n'

docker compose --env-file .env -f docker-compose.dev.yml up --build