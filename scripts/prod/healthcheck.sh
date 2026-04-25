#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUNTIME_ROOT="${ANIMO_BEE_RUNTIME_ROOT:-/mnt/bee-disk/projects/animo-bee}"
DB_PATH="${ANIMO_BEE_DB_PATH:-$RUNTIME_ROOT/db/orchestrator.sqlite}"
PROD_COMPOSE_FILE="${ANIMO_BEE_PROD_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.prod.yml}"
HEALTH_URL="${ANIMO_BEE_HEALTH_URL:-http://127.0.0.1:3001/health}"
COMPOSE_PROJECT="${ANIMO_BEE_COMPOSE_PROJECT:-animo-bee-prod}"
OPENCV_ENABLED="${ANIMO_BEE_OPENCV_ENABLED:-false}"

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

ENV_FILE="$(resolve_env_file)"

declare -a FAILURES=()
declare -a WARNINGS=()

fail() {
  FAILURES+=("$1")
  echo "[FAIL] $1"
}

warn() {
  WARNINGS+=("$1")
  echo "[WARN] $1"
}

pass() {
  echo "[ OK ] $1"
}

check_runtime_paths() {
  local -a required_paths=(
    "$RUNTIME_ROOT/data/camera_1"
    "$RUNTIME_ROOT/data/camera_2"
    "$RUNTIME_ROOT/data/processed"
    "$RUNTIME_ROOT/data/rejected"
    "$RUNTIME_ROOT/logs"
    "$RUNTIME_ROOT/db"
  )

  for path in "${required_paths[@]}"; do
    if [[ -d "$path" ]]; then
      pass "Directory exists: $path"
    else
      fail "Missing directory: $path"
    fi
  done

  if [[ -f "$DB_PATH" ]]; then
    pass "SQLite file exists: $DB_PATH"
  else
    warn "SQLite file is missing: $DB_PATH"
  fi
}

check_sqlite_integrity() {
  if [[ ! -f "$DB_PATH" ]]; then
    return
  fi

  if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 is not installed; skipping database integrity check."
    return
  fi

  local check_result
  check_result="$(sqlite3 "$DB_PATH" "PRAGMA quick_check;" 2>/dev/null || true)"

  if [[ "$check_result" == "ok" ]]; then
    pass "SQLite quick_check returned ok."
  else
    fail "SQLite quick_check did not return ok. Output: ${check_result:-<empty>}"
  fi
}

check_motioneye() {
  local service_detected=0
  local service_active=0
  local process_detected=0

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "motioneye.service"; then
      service_detected=1
      pass "Detected motioneye.service unit file."
      if systemctl is-active --quiet motioneye; then
        service_active=1
        pass "motionEye service is active."
      else
        warn "motioneye.service exists but is not active."
      fi
    fi
  fi

  if pgrep -fa "[m]otioneye" >/dev/null 2>&1; then
    process_detected=1
    pass "Detected running motionEye process."
  fi

  if [[ "$service_detected" -eq 0 && "$process_detected" -eq 0 ]]; then
    fail "motionEye is not detected (no service unit and no running process)."
  elif [[ "$service_detected" -eq 1 && "$service_active" -eq 0 && "$process_detected" -eq 0 ]]; then
    warn "motionEye is installed but not currently running."
  fi
}

check_compose_runtime() {
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker command not found."
    return
  fi

  if docker compose version >/dev/null 2>&1; then
    pass "Docker Compose plugin is available."
  else
    fail "docker compose command failed."
    return
  fi

  if [[ ! -f "$PROD_COMPOSE_FILE" ]]; then
    fail "Production compose file not found: $PROD_COMPOSE_FILE"
    return
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    fail "Environment file not found: $ENV_FILE"
    return
  fi

  local -a compose_args=(--env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$PROD_COMPOSE_FILE")

  if [[ "$OPENCV_ENABLED" == "true" ]]; then
    compose_args=(--env-file "$ENV_FILE" --profile opencv -p "$COMPOSE_PROJECT" -f "$PROD_COMPOSE_FILE")
  fi

  if docker compose "${compose_args[@]}" config >/dev/null 2>&1; then
    pass "Production compose file renders successfully."
  else
    fail "Production compose file could not be rendered: $PROD_COMPOSE_FILE"
    return
  fi

  local running_services
  running_services="$(docker compose "${compose_args[@]}" ps --services --status running 2>/dev/null || true)"

  if [[ -z "$running_services" ]]; then
    fail "No running services found for $PROD_COMPOSE_FILE"
    return
  fi

  if grep -qx "app" <<<"$running_services"; then
    pass "Production app service is running."
  else
    fail "Production app service is not running."
  fi

  if [[ "$OPENCV_ENABLED" == "true" ]]; then
    if grep -qx "opencv-worker" <<<"$running_services"; then
      pass "Optional OpenCV worker service is running."
    else
      warn "OpenCV profile is enabled but opencv-worker is not running."
    fi
  fi

  pass "Running services detected for production compose stack."
  echo "$running_services" | sed 's/^/  - /'
}

check_local_health_endpoint() {
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not installed; skipping HTTP health check."
    return
  fi

  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    pass "Local health endpoint responded: $HEALTH_URL"
  else
    fail "Local health endpoint did not respond: $HEALTH_URL"
  fi
}

print_summary_and_exit() {
  echo ""
  echo "=== Healthcheck Summary ==="
  echo "Failures: ${#FAILURES[@]}"
  echo "Warnings: ${#WARNINGS[@]}"

  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo ""
    echo "Action required:"
    for item in "${FAILURES[@]}"; do
      echo "  - $item"
    done
    exit 1
  fi

  echo "Healthcheck completed without blocking failures."
}

echo "=== Animo Bee Production Healthcheck ==="
echo "PROJECT_ROOT=$PROJECT_ROOT"
echo "RUNTIME_ROOT=$RUNTIME_ROOT"

check_runtime_paths
check_sqlite_integrity
check_motioneye
check_compose_runtime
check_local_health_endpoint
print_summary_and_exit