#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${ANIMO_BEE_RUNTIME_ROOT:-/mnt/bee-disk/projects/animo-bee}"
DB_FILE_NAME="${ANIMO_BEE_DB_FILE:-orchestrator.sqlite}"
OWNER="${ANIMO_BEE_OWNER:-${SUDO_USER:-$(id -un)}}"
GROUP="${ANIMO_BEE_GROUP:-$OWNER}"
SKIP_MOUNT_CHECK="${ANIMO_BEE_SKIP_MOUNT_CHECK:-0}"

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

require_storage_mount() {
  local storage_root="/mnt/bee-disk"

  if [[ "$RUNTIME_ROOT" == "$storage_root"* && "$SKIP_MOUNT_CHECK" != "1" ]]; then
    if ! command -v mountpoint >/dev/null 2>&1; then
      warn "mountpoint command not available; skipping mount validation."
      return
    fi

    if mountpoint -q "$storage_root"; then
      pass "Storage mount verified: $storage_root"
    else
      fail "Expected mounted storage at $storage_root. Set ANIMO_BEE_SKIP_MOUNT_CHECK=1 to bypass intentionally."
    fi
  fi
}

create_layout() {
  local -a directories=(
    "$RUNTIME_ROOT"
    "$RUNTIME_ROOT/data/camera_1"
    "$RUNTIME_ROOT/data/camera_2"
    "$RUNTIME_ROOT/data/processed"
    "$RUNTIME_ROOT/data/rejected"
    "$RUNTIME_ROOT/logs"
    "$RUNTIME_ROOT/db"
  )

  for dir in "${directories[@]}"; do
    mkdir -p "$dir"
    chmod 775 "$dir"
    pass "Ensured directory: $dir"
  done

  local db_path="$RUNTIME_ROOT/db/$DB_FILE_NAME"
  touch "$db_path"
  chmod 664 "$db_path"
  pass "Ensured database file: $db_path"
}

apply_ownership() {
  if [[ "$EUID" -ne 0 ]]; then
    warn "Not running as root; ownership changes skipped."
    return
  fi

  chown -R "$OWNER:$GROUP" "$RUNTIME_ROOT"
  pass "Applied ownership $OWNER:$GROUP to $RUNTIME_ROOT"
}

validate_writable_paths() {
  local -a required_paths=(
    "$RUNTIME_ROOT/data/camera_1"
    "$RUNTIME_ROOT/data/camera_2"
    "$RUNTIME_ROOT/data/processed"
    "$RUNTIME_ROOT/data/rejected"
    "$RUNTIME_ROOT/logs"
    "$RUNTIME_ROOT/db"
    "$RUNTIME_ROOT/db/$DB_FILE_NAME"
  )

  for path in "${required_paths[@]}"; do
    if [[ -w "$path" ]]; then
      pass "Writable path: $path"
    else
      fail "Path is not writable: $path"
    fi
  done
}

print_layout() {
  echo ""
  echo "=== Runtime Layout ==="
  echo "RUNTIME_ROOT=$RUNTIME_ROOT"
  echo "DB_PATH=$RUNTIME_ROOT/db/$DB_FILE_NAME"
  echo ""
  ls -ld \
    "$RUNTIME_ROOT" \
    "$RUNTIME_ROOT/data" \
    "$RUNTIME_ROOT/data/camera_1" \
    "$RUNTIME_ROOT/data/camera_2" \
    "$RUNTIME_ROOT/data/processed" \
    "$RUNTIME_ROOT/data/rejected" \
    "$RUNTIME_ROOT/logs" \
    "$RUNTIME_ROOT/db" \
    "$RUNTIME_ROOT/db/$DB_FILE_NAME"
}

print_summary_and_exit() {
  echo ""
  echo "=== Layout Summary ==="
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

  echo "Runtime layout is ready."
}

echo "=== Create Runtime Layout ==="
require_storage_mount
create_layout
apply_ownership
validate_writable_paths
print_layout
print_summary_and_exit