#!/usr/bin/env bash
set -euo pipefail

INSTALL_MISSING=0

usage() {
  cat <<'USAGE'
Usage: ./scripts/prod/bootstrap-native.sh [--install]

Options:
  --install   Install missing native prerequisites with apt-get.
  -h, --help  Show this help message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL_MISSING=1
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

require_debian_family() {
  if [[ ! -f /etc/os-release ]]; then
    fail "/etc/os-release not found. Cannot validate host OS."
    return
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  local distro_id="${ID:-unknown}"
  local distro_name="${PRETTY_NAME:-unknown}"

  echo "Host OS: ${distro_name}"
  echo "Host Arch: $(uname -m)"

  case "$distro_id" in
    debian|ubuntu|raspbian)
      pass "Debian-family host detected (${distro_id})."
      ;;
    *)
      fail "Unsupported distro '${distro_id}'. Expected debian, ubuntu, or raspbian."
      ;;
  esac
}

install_packages_if_requested() {
  if [[ "$INSTALL_MISSING" -ne 1 ]]; then
    return
  fi

  if [[ "$EUID" -ne 0 ]]; then
    fail "--install requires root privileges. Re-run with sudo."
    return
  fi

  local compose_pkg=""
  if apt-cache show docker-compose-plugin >/dev/null 2>&1; then
    compose_pkg="docker-compose-plugin"
  elif apt-cache show docker-compose-v2 >/dev/null 2>&1; then
    compose_pkg="docker-compose-v2"
  else
    warn "Neither docker-compose-plugin nor docker-compose-v2 is available via apt metadata."
  fi

  local -a install_list=(
    ca-certificates
    curl
    git
    sqlite3
    docker.io
  )

  if [[ -n "$compose_pkg" ]]; then
    install_list+=("$compose_pkg")
  fi

  echo "Installing native prerequisites: ${install_list[*]}"
  apt-get update
  apt-get install -y "${install_list[@]}"
}

validate_commands() {
  local -a required_commands=(curl git sqlite3 docker)

  for cmd in "${required_commands[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      pass "Found command: $cmd"
    else
      fail "Missing command: $cmd"
    fi
  done

  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      pass "Docker Compose plugin is available."
    else
      fail "Docker Compose plugin is not available (docker compose command failed)."
    fi
  fi
}

validate_motioneye_presence() {
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
    fail "motionEye was not detected (no service unit and no running process)."
  elif [[ "$service_detected" -eq 1 && "$service_active" -eq 0 && "$process_detected" -eq 0 ]]; then
    warn "motionEye is installed but not currently running."
  fi

  echo "motionEye validation only checks presence and runtime state."
  echo "This script does not modify motionEye configuration."
}

validate_storage_anchor() {
  local storage_root="/mnt/bee-disk"

  if [[ -d "$storage_root" ]]; then
    pass "Storage root exists: $storage_root"
  else
    warn "Storage root not found: $storage_root"
  fi
}

print_summary_and_exit() {
  echo ""
  echo "=== Bootstrap Summary ==="
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

  echo "Native prerequisite validation completed successfully."
}

echo "=== Native Pi Bootstrap Validation ==="
require_debian_family
install_packages_if_requested
validate_commands
validate_motioneye_presence
validate_storage_anchor
print_summary_and_exit