#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUNTIME_ROOT="${ANIMO_BEE_RUNTIME_ROOT:-/mnt/bee-disk/projects/animo-bee}"
DB_PATH="${ANIMO_BEE_DB_PATH:-$RUNTIME_ROOT/db/orchestrator.sqlite}"
PROD_COMPOSE_FILE="${ANIMO_BEE_PROD_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.prod.yml}"
HEALTH_URL="${ANIMO_BEE_HEALTH_URL:-http://127.0.0.1:3001/health}"
COMPOSE_PROJECT="${ANIMO_BEE_COMPOSE_PROJECT:-animo-bee-prod}"
CURL_TIMEOUT_SECONDS="${ANIMO_BEE_CURL_TIMEOUT_SECONDS:-5}"

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

if [[ -f "$ENV_FILE" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  set -u
fi

OPENCV_MODE="${OPENCV_MODE:-${ANIMO_BEE_OPENCV_MODE:-}}"

if [[ -z "$OPENCV_MODE" ]]; then
  if [[ "${ANIMO_BEE_OPENCV_ENABLED:-${OPENCV_ENABLED:-false}}" == "true" ]]; then
    OPENCV_MODE="shadow"
  else
    OPENCV_MODE="disabled"
  fi
fi

if [[ "$OPENCV_MODE" == "disabled" ]]; then
  OPENCV_ENABLED="false"
else
  OPENCV_ENABLED="true"
fi

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

validate_opencv_mode() {
  case "$OPENCV_MODE" in
    disabled|shadow|enforce)
      pass "OpenCV mode is valid: $OPENCV_MODE"
      ;;
    *)
      fail "OpenCV mode is invalid: $OPENCV_MODE"
      OPENCV_MODE="disabled"
      OPENCV_ENABLED="false"
      ;;
  esac
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

      if [[ -r "$path" && -w "$path" ]]; then
        pass "Directory is readable and writable: $path"
      else
        fail "Directory is not readable and writable: $path"
      fi
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
    return
  fi

  local -a required_tables=(clips upload_attempts runtime_config irrigation_events)

  for table in "${required_tables[@]}"; do
    local table_exists
    table_exists="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '$table';" 2>/dev/null || true)"

    if [[ "$table_exists" == "1" ]]; then
      pass "SQLite table exists: $table"
    else
      fail "SQLite table is missing: $table"
    fi
  done
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

  if [[ "$OPENCV_MODE" != "disabled" ]]; then
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

  if [[ "$OPENCV_MODE" != "disabled" ]]; then
    if grep -qx "opencv-worker" <<<"$running_services"; then
      pass "Optional OpenCV worker service is running."
    else
      warn "OpenCV mode is $OPENCV_MODE but opencv-worker is not running."
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

  local health_response
  health_response="$(curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$HEALTH_URL" 2>/dev/null || true)"

  if [[ -n "$health_response" ]]; then
    pass "Local health endpoint responded: $HEALTH_URL"
  else
    fail "Local health endpoint did not respond: $HEALTH_URL"
    return
  fi

  if grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$health_response"; then
    pass "Local health endpoint reports status ok."
  else
    fail "Local health endpoint did not report status ok."
  fi

  if grep -Eq '"service"[[:space:]]*:[[:space:]]*"animo-bee"' <<<"$health_response"; then
    pass "Local health endpoint reports service identity."
  else
    fail "Local health endpoint did not report animo-bee service identity."
  fi

  if grep -Eq '"opencv"[[:space:]]*:' <<<"$health_response"; then
    pass "Local health endpoint includes OpenCV runtime status."
  else
    fail "Local health endpoint is missing OpenCV runtime status."
    return
  fi

  if grep -Eq "\"opencv\"[[:space:]]*:[[:space:]]*\\{[^}]*\"mode\"[[:space:]]*:[[:space:]]*\"$OPENCV_MODE\"" <<<"$health_response"; then
    pass "Local health endpoint reports OpenCV mode $OPENCV_MODE."
  else
    fail "Local health endpoint OpenCV mode does not match expected mode: $OPENCV_MODE"
  fi

  local expected_opencv_enabled="true"

  if [[ "$OPENCV_MODE" == "disabled" ]]; then
    expected_opencv_enabled="false"
  fi

  if grep -Eq "\"opencv\"[[:space:]]*:[[:space:]]*\\{[^}]*\"enabled\"[[:space:]]*:[[:space:]]*$expected_opencv_enabled" <<<"$health_response"; then
    pass "Local health endpoint reports OpenCV enabled=$expected_opencv_enabled."
  else
    fail "Local health endpoint OpenCV enabled flag does not match mode-derived expectation."
  fi

  if grep -Eq '"opencv"[[:space:]]*:[[:space:]]*\{[^}]*"failOpen"[[:space:]]*:[[:space:]]*(true|false)' <<<"$health_response"; then
    pass "Local health endpoint includes OpenCV failOpen status."
  else
    fail "Local health endpoint is missing OpenCV failOpen status."
  fi

  if grep -Eq '"opencv"[[:space:]]*:[[:space:]]*\{[^}]*"retainRejectedFiles"[[:space:]]*:[[:space:]]*(true|false)' <<<"$health_response"; then
    pass "Local health endpoint includes OpenCV retainRejectedFiles status."
  else
    fail "Local health endpoint is missing OpenCV retainRejectedFiles status."
  fi

  if grep -Eq '"queue"[[:space:]]*:' <<<"$health_response"; then
    pass "Local health endpoint includes queue summary."
  else
    fail "Local health endpoint is missing queue summary."
  fi

  if grep -Eq '"upload"[[:space:]]*:' <<<"$health_response"; then
    pass "Local health endpoint includes upload worker status."
  else
    fail "Local health endpoint is missing upload worker status."
  fi
}

check_local_queue_endpoint() {
  if ! command -v curl >/dev/null 2>&1; then
    return
  fi

  local queue_url="${ANIMO_BEE_QUEUE_URL:-}"

  if [[ -z "$queue_url" ]]; then
    if [[ "$HEALTH_URL" == */health ]]; then
      queue_url="${HEALTH_URL%/health}/queue"
    else
      warn "ANIMO_BEE_QUEUE_URL is not set and queue URL could not be inferred."
      return
    fi
  fi

  local queue_response
  queue_response="$(curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" "$queue_url" 2>/dev/null || true)"

  if [[ -n "$queue_response" ]]; then
    pass "Local queue endpoint responded: $queue_url"
  else
    fail "Local queue endpoint did not respond: $queue_url"
    return
  fi

  if grep -Eq '"summary"[[:space:]]*:' <<<"$queue_response" && grep -Eq '"clips"[[:space:]]*:' <<<"$queue_response"; then
    pass "Local queue endpoint exposes summary and clips."
  else
    fail "Local queue endpoint response is missing summary or clips."
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
echo "OPENCV_MODE=$OPENCV_MODE"

validate_opencv_mode
check_runtime_paths
check_sqlite_integrity
check_motioneye
check_compose_runtime
check_local_health_endpoint
check_local_queue_endpoint
print_summary_and_exit