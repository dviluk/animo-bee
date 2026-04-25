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

echo "=== Starting Native Motion Host ==="

# Check binary
if ! command -v motion >/dev/null; then
    echo "ERROR: motion binary not found in PATH."
    echo "Run ./install-motion-host.sh to set up the host."
    exit 1
fi

# Ensure runtime directories exist
mkdir -p "$RUNTIME_DIR/camera_1" "$RUNTIME_DIR/camera_2"

# Start motion with config file
echo "Using config file: $CONFIG_FILE"
echo "Outputs will be written to: $RUNTIME_DIR/camera_1 (default)"

# Change directory so relative path 'target_dir ../../runtime/*' inside config resolves correctly
cd "$PROJECT_ROOT/config/motion"

# Execute motion in the foreground or background (using nohup/&) based on arg
if [ "${1:-}" = "-d" ] || [ "${1:-}" = "--daemon" ]; then
    echo "Starting in background..."
    nohup motion -c "motion.conf" >/dev/null 2>&1 &
    echo "Motion started with PID $!"
else
    echo "Starting in foreground. Press Ctrl+C to stop."
    motion -c "motion.conf"
fi
