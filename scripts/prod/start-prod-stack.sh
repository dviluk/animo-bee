#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

COMPOSE_FILE="${ANIMO_BEE_PROD_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.prod.yml}"
COMPOSE_PROJECT="${ANIMO_BEE_COMPOSE_PROJECT:-animo-bee-prod}"
RUNTIME_ROOT="${ANIMO_BEE_RUNTIME_ROOT:-/mnt/bee-disk/projects/animo-bee}"
APP_PORT="${ANIMO_BEE_APP_PORT:-3001}"
OPENCV_ENABLED="${ANIMO_BEE_OPENCV_ENABLED:-false}"
BUILD_ARG="--build"

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
Usage: ./scripts/prod/start-prod-stack.sh [--with-opencv] [--no-build]

Options:
  --with-opencv  Start the optional OpenCV worker profile.
  --no-build     Skip the image rebuild step.
  -h, --help     Show this help message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-opencv)
      OPENCV_ENABLED="true"
      shift
      ;;
    --no-build)
      BUILD_ARG=""
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
  echo "ERROR: docker command not found. Run ./scripts/prod/bootstrap-native.sh first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose is not available on this host."
  exit 1
fi

echo "=== Start Animo Bee Production Stack ==="
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "COMPOSE_FILE=$COMPOSE_FILE"
echo "ENV_FILE=$ENV_FILE"
echo "RUNTIME_ROOT=$RUNTIME_ROOT"
echo "COMPOSE_PROJECT=$COMPOSE_PROJECT"
echo "APP_PORT=$APP_PORT"
echo "OPENCV_ENABLED=$OPENCV_ENABLED"

export ANIMO_BEE_RUNTIME_ROOT="$RUNTIME_ROOT"
export ANIMO_BEE_APP_PORT="$APP_PORT"
export ANIMO_BEE_OPENCV_ENABLED="$OPENCV_ENABLED"

"$PROJECT_ROOT/scripts/prod/create-runtime-layout.sh"

compose_args=(--env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")

if [[ "$OPENCV_ENABLED" == "true" ]]; then
  compose_args=(--env-file "$ENV_FILE" --profile opencv -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")
fi

docker compose "${compose_args[@]}" config >/dev/null

up_args=(up -d)
if [[ -n "$BUILD_ARG" ]]; then
  up_args+=("$BUILD_ARG")
fi

docker compose "${compose_args[@]}" "${up_args[@]}"
docker compose "${compose_args[@]}" ps

echo "Stack started. Verify with ./scripts/prod/healthcheck.sh"