#!/usr/bin/env bash
#
# Start script for native Motion on Ubuntu host
# Reads checked-in motion configuration and writes directly to runtime/
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
CONFIG_FILE="$PROJECT_ROOT/config/motion/motion.conf"
RUNTIME_DIR="$PROJECT_ROOT/runtime"

echo "=== Starting Native motionEye Host ==="

# Check binary
if ! command -v meyectl >/dev/null; then
    echo "ERROR: meyectl binary not found in PATH."
    echo "Run ./install-motion-host.sh to set up the host."
    exit 1
fi

# Ensure runtime directories exist
mkdir -p "$RUNTIME_DIR/camera_1" "$RUNTIME_DIR/camera_2"

if systemctl status motioneye >/dev/null 2>&1; then
    echo "Restarting systemd motioneye service..."
    systemctl restart motioneye
else
    echo "Starting systemd motioneye service..."
    systemctl start motioneye
fi

echo "motionEye started! Access the Web UI at http://localhost:8765"
