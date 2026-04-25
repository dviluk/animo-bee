#!/usr/bin/env bash
#
# Stop native motionEye and motion gracefully
#

set -euo pipefail

motioneye_running() {
    pgrep -f "meyectl startserver" >/dev/null || pgrep -x "motion" >/dev/null
}

echo "=== Stopping motionEye Service (Conda) ==="

if motioneye_running; then
    echo "Found active meyectl or motion processes. Sending SIGTERM..."
    pkill -f -TERM "meyectl startserver" || true
    pkill -x -TERM "motion" || true
    
    # Wait for clean shutdown
    SLEEP_SEC=0
    while motioneye_running && [ $SLEEP_SEC -lt 5 ]; do
        sleep 1
        SLEEP_SEC=$((SLEEP_SEC + 1))
    done
    
    # Force kill if still running
    if motioneye_running; then
        echo "Processes still running. Sending SIGKILL..."
        pkill -f -KILL "meyectl startserver" || true
        pkill -x -KILL "motion" || true
    fi
    echo "All motion and motionEye processes stopped cleanly."
else
    echo "No running motion or motionEye processes found."
fi
