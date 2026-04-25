#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

COMPOSE_FILE="${ANIMO_BEE_PROD_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.prod.yml}"
COMPOSE_PROJECT="${ANIMO_BEE_COMPOSE_PROJECT:-animo-bee-prod}"

resolve_env_file() {
  if [[ -n "${ANIMO_BEE_ENV_FILE:-}" ]]; then
    printf '%s\n' "$ANIMO_BEE_ENV_FILE"
    return
  fi

  if [[ -f "$PROJECT_ROOT/.env.prod" ]]; then
    printf '%s\n' "$PROJECT_ROOT/.env.prod"
    return
  fi

  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    printf '%s\n' "$PROJECT_ROOT/.env"
    return
  fi

  printf '%s\n' "$PROJECT_ROOT/.env.example"
}

usage() {
  cat <<'USAGE'
Usage: ./scripts/prod/stop-prod-stack.sh [--volumes]

Options:
  --volumes     Remove anonymous volumes during shutdown.
  -h, --help    Show this help message.
USAGE
}

REMOVE_VOLUMES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --volumes)
      REMOVE_VOLUMES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

ENV_FILE="$(resolve_env_file)"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: Production compose file not found: $COMPOSE_FILE"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Environment file not found: $ENV_FILE"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker command not found."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose is not available on this host."
  exit 1
fi

echo "=== Stop Animo Bee Production Stack ==="
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "COMPOSE_FILE=$COMPOSE_FILE"
echo "ENV_FILE=$ENV_FILE"
echo "COMPOSE_PROJECT=$COMPOSE_PROJECT"

down_args=(down --remove-orphans)
if [[ "$REMOVE_VOLUMES" -eq 1 ]]; then
  down_args+=(--volumes)
fi

docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "${down_args[@]}"