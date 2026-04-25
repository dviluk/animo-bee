#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

echo "=== Animo Bee Motion Flow Verification ==="
echo "Validating Docker to Host integration..."
failure=0

# 1. Check if Motion / MotionEye is running
echo "[1/4] Checking host MotionEye/Motion status..."
if pgrep -f "motioneye" >/dev/null || pgrep -f "motion" >/dev/null; then
    echo "  ✅ Motion/MotionEye process found running natively."
else
    echo "  ❌ Native Motion/MotionEye process NOT found."
    echo "     Did you run ./scripts/dev/start-motion-host.sh?"
    failure=1
fi

# 2. Check if Dockerized orchestrator is healthy
echo "[2/4] Checking Dockerized animo-bee health..."
if curl -fsS http://localhost:3001/health >/dev/null 2>&1; then
    echo "  ✅ animo-bee orchestrator responds at http://localhost:3001/health"
else
    echo "  ❌ animo-bee orchestrator NOT responding."
    echo "     Did you start it with ./scripts/dev/start-dev.sh?"
    failure=1
fi

# 3. Check shared runtime directories existence
echo "[3/4] Checking shared runtime directories..."
camera1_dir="runtime/camera_1"
if [ -d "$camera1_dir" ]; then
    if [ -w "$camera1_dir" ]; then
        echo "  ✅ \$camera1_dir exists and is writable."
    else
        echo "  ❌ \$camera1_dir exists but is NOT writable."
        failure=1
    fi
else
    echo "  ❌ \$camera1_dir does NOT exist."
    failure=1
fi

# 4. Check for capturing devices / camera
echo "[4/4] Checking host video devices..."
if ls /dev/video* 1> /dev/null 2>&1; then
    echo "  ✅ /dev/video device(s) found on host."
else
    echo "  ❌ No /dev/video* devices found. Capture will fail."
    echo "     If running in WSL or a VM, ensure device is passed through."
    failure=1
fi

echo "=========================================="
if [ "$failure" -eq 0 ]; then
    echo "✅ VERIFICATION PASSED: Happy path looks good."
    exit 0
else
    echo "❌ VERIFICATION FAILED: Resolve the issues above."
    exit 1
fi
