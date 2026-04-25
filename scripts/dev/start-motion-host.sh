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

echo "=== Starting Native motionEye Host (Conda) ==="

# Check binary
if ! command -v meyectl >/dev/null; then
    echo "ERROR: meyectl binary not found in your Conda PATH."
    echo "Run ./install-motion-host.sh without sudo to install via pip."
    exit 1
fi

# Ensure runtime directories exist
mkdir -p "$RUNTIME_DIR/camera_1" "$RUNTIME_DIR/camera_2"

echo "Creating local motioneye configuration directory (no root required)..."
mkdir -p "$PROJECT_ROOT/config/motioneye"

# Create a local motioneye base config if it doesn't exist mapping to the current folder
if [ ! -f "$PROJECT_ROOT/config/motioneye/motioneye.conf" ]; then
    cat > "$PROJECT_ROOT/config/motioneye/motioneye.conf" << EOF
conf_path .
run_path $RUNTIME_DIR
log_path $RUNTIME_DIR
media_path $RUNTIME_DIR
port 8765
EOF
fi

cd "$PROJECT_ROOT/config/motioneye"

# Execute meyectl directly from the active Conda environment
if [ "${1:-}" = "-d" ] || [ "${1:-}" = "--daemon" ]; then
    echo "Starting meyectl in background..."
    nohup meyectl startserver -c ./motioneye.conf >/dev/null 2>&1 &
    echo "motionEye started with PID $!"
else
    echo "Starting meyectl in foreground. Press Ctrl+C to stop."
    meyectl startserver -c ./motioneye.conf
fi

echo "motionEye started! Access the Web UI at http://localhost:8765"
