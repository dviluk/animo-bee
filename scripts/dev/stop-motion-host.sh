#!/usr/bin/env bash
#
# Stop native motionEye and motion gracefully
#

set -euo pipefail

echo "=== Stopping motionEye Service ==="

if systemctl status motioneye >/dev/null 2>&1; then
    echo "motionEye service is running. Stopping via systemctl..."
    systemctl stop motioneye
    echo "motionEye stopped."
else
    echo "motionEye service is not running via systemd."
fi

# Fallback: check if meyectl or motion are running independently
if pgrep -x "meyectl" >/dev/null || pgrep -x "motion" >/dev/null; then
    echo "Found rogue meyectl or motion processes. Sending SIGTERM..."
    pkill -x -TERM "meyectl" || true
    pkill -x -TERM "motion" || true
    
    # Wait for clean shutdown
    SLEEP_SEC=0
    while (pgrep -x "meyectl" >/dev/null || pgrep -x "motion" >/dev/null) && [ $SLEEP_SEC -lt 5 ]; do
        sleep 1
        SLEEP_SEC=$((SLEEP_SEC + 1))
    done
    
    # Force kill if still running
    if pgrep -x "meyectl" >/dev/null || pgrep -x "motion" >/dev/null; then
        echo "Processes still running. Sending SIGKILL..."
        pkill -x -KILL "meyectl" || true
        pkill -x -KILL "motion" || true
    fi
    echo "All motion and motionEye processes stopped cleanly."
else
    echo "No rogue motion or motionEye processes found."
fi
