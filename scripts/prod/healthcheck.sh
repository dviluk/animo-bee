#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUNTIME_ROOT="${ANIMO_BEE_RUNTIME_ROOT:-/mnt/bee-disk/projects/animo-bee}"
DB_PATH="${ANIMO_BEE_DB_PATH:-$RUNTIME_ROOT/db/orchestrator.sqlite}"
PROD_COMPOSE_FILE="${ANIMO_BEE_PROD_COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.prod.yml}"
HEALTH_URL="${ANIMO_BEE_HEALTH_URL:-http://127.0.0.1:3001/health}"

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
    warn "Production compose file not found: $PROD_COMPOSE_FILE"
    return
  fi

  local running_services
  running_services="$(docker compose -f "$PROD_COMPOSE_FILE" ps --services --status running 2>/dev/null || true)"

  if [[ -z "$running_services" ]]; then
    warn "No running services found for $PROD_COMPOSE_FILE"
    return
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
    warn "Local health endpoint did not respond: $HEALTH_URL"
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