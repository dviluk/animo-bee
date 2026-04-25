#!/usr/bin/env bash
set -euo pipefail

motioneye_running() {
    pgrep -f "meyectl startserver" >/dev/null || pgrep -x "motion" >/dev/null
}

echo "=== Host Baseline Validation ==="
cat /etc/os-release | grep PRETTY_NAME
uname -m

echo ""
echo "=== Docker Availability ==="
command -v docker >/dev/null && docker --version || echo "Docker not found"
docker compose version 2>/dev/null || echo "Docker Compose not found"

echo ""
echo "=== Motion Package Availability ==="
apt-cache policy motion 2>/dev/null | grep -E "Candidate|Installed" || echo "Motion package metadata not found"
apt-cache policy motioneye 2>/dev/null | grep -E "Candidate|Installed" || echo "motionEye package not available via apt"

echo ""
echo "=== Camera Devices ==="
ls -l /dev/video* 2>/dev/null || echo "No /dev/video* devices found (Expected for current virtual/remote baseline)."
command -v v4l2-ctl >/dev/null && v4l2-ctl --list-devices || echo "v4l2-ctl not available or failed"

echo ""
echo "=== Config Directory Validation ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../../config/motion"
if [ -d "$CONFIG_DIR" ]; then
    echo "Found config directory: $CONFIG_DIR"
    ls -l "$CONFIG_DIR"
else
    echo "Warning: config directory $CONFIG_DIR not found"
fi

echo ""
echo "=== motionEye State (Conda) ==="
if motioneye_running; then
    echo "motionEye meyectl process is currently running."
else
    echo "motionEye meyectl process is inactive or not found."
fi

echo ""
echo "Host baseline validation complete."
