#!/usr/bin/env bash
set -euo pipefail

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

echo ""
echo "Host baseline validation complete."
