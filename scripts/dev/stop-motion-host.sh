#!/usr/bin/env bash
#
# Stop native Motion cleanly on the host
#

set -euo pipefail

echo "=== Stopping Native Motion ==="

# Check if motion is running
if pgrep -x "motion" >/dev/null; then
    echo "Found motion processes. Sending SIGTERM..."
    pkill -x -TERM "motion"
    
    # Wait for clean shutdown
    SLEEP_SEC=0
    while pgrep -x "motion" >/dev/null && [ $SLEEP_SEC -lt 5 ]; do
        sleep 1
        SLEEP_SEC=$((SLEEP_SEC + 1))
    done
    
    # Force kill if still running
    if pgrep -x "motion" >/dev/null; then
        echo "Motion still running. Sending SIGKILL..."
        pkill -x -KILL "motion"
    fi
    echo "Motion stopped cleanly."
else
    echo "No motion processes found."
fi
