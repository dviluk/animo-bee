#!/usr/bin/env bash
set -euo pipefail

project_root="${ANIMO_BEE_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
config_dir="${ANIMO_BEE_MOTIONEYE_CONFIG_DIR:-$project_root/config/motioneye}"
health_url="${ANIMO_BEE_HEALTH_URL:-http://localhost:3001/health}"
motioneye_url="${ANIMO_BEE_MOTIONEYE_URL:-http://localhost:8765}"
video_device_glob="${ANIMO_BEE_VIDEO_DEVICE_GLOB:-/dev/video*}"
cd "$project_root"

extract_target_dir() {
    awk '$1 == "target_dir" { $1 = ""; sub(/^ +/, ""); print; exit }' "$1"
}

resolve_path() {
    local base_dir="$1"
    local candidate="$2"

    if [[ "$candidate" = /* ]]; then
        realpath -m "$candidate"
    else
        realpath -m "$base_dir/$candidate"
    fi
}

motioneye_running() {
    pgrep -f "meyectl startserver" >/dev/null || pgrep -x "motion" >/dev/null
}

check_camera_target() {
    local camera_config_path="$1"
    local expected_dir="$2"
    local configured_target_dir=""
    local resolved_target_dir=""
    local resolved_expected_dir=""

    configured_target_dir="$(extract_target_dir "$camera_config_path")"
    resolved_expected_dir="$(realpath -m "$expected_dir")"

    if [[ -z "$configured_target_dir" ]]; then
        echo "  ❌ $(basename "$camera_config_path") does not declare target_dir."
        failure=1
        return
    fi

    resolved_target_dir="$(resolve_path "$(dirname "$camera_config_path")" "$configured_target_dir")"

    if [[ "$resolved_target_dir" != "$resolved_expected_dir" ]]; then
        echo "  ❌ $(basename "$camera_config_path") writes to $resolved_target_dir"
        echo "     Expected: $resolved_expected_dir"
        failure=1
        return
    fi

    if [[ -d "$resolved_target_dir" && -w "$resolved_target_dir" ]]; then
        echo "  ✅ $(basename "$camera_config_path") targets $resolved_target_dir and it is writable."
    else
        echo "  ❌ $resolved_target_dir is missing or not writable."
        failure=1
    fi
}

echo "=== Animo Bee Motion Flow Verification ==="
echo "Validating Docker to Host integration..."
failure=0

echo "[1/4] Checking host MotionEye status..."
if motioneye_running; then
    echo "  ✅ Motion/MotionEye process found running natively."
else
    echo "  ❌ Native Motion/MotionEye process NOT found."
    echo "     Did you run ./scripts/dev/start-motion-host.sh?"
    failure=1
fi

if curl -fsS "$motioneye_url" >/dev/null 2>&1; then
    echo "  ✅ motionEye Web UI responds at $motioneye_url"
else
    echo "  ❌ motionEye Web UI is NOT responding at $motioneye_url"
    failure=1
fi

echo "[2/4] Checking Dockerized animo-bee health..."
if curl -fsS "$health_url" >/dev/null 2>&1; then
    echo "  ✅ animo-bee orchestrator responds at $health_url"
else
    echo "  ❌ animo-bee orchestrator NOT responding."
    echo "     Did you start it with ./scripts/dev/start-dev.sh?"
    failure=1
fi

echo "[3/4] Checking configured capture targets..."
motion_conf="$config_dir/motion.conf"
if [[ ! -f "$motion_conf" ]]; then
    echo "  ❌ motionEye config is missing: $motion_conf"
    failure=1
else
    mapfile -t camera_configs < <(awk '$1 == "camera" { print $2 }' "$motion_conf")

    if [[ ${#camera_configs[@]} -eq 0 ]]; then
        echo "  ❌ $motion_conf does not list any active camera configs."
        failure=1
    fi

    for camera_config in "${camera_configs[@]}"; do
        resolved_camera_config="$(resolve_path "$config_dir" "$camera_config")"

        if [[ ! -f "$resolved_camera_config" ]]; then
            echo "  ❌ Camera config is missing: $resolved_camera_config"
            failure=1
            continue
        fi

        case "$(basename "$resolved_camera_config")" in
            camera-1.conf)
                check_camera_target "$resolved_camera_config" "$project_root/runtime/camera_1"
                ;;
            camera-2.conf)
                check_camera_target "$resolved_camera_config" "$project_root/runtime/camera_2"
                ;;
            *)
                echo "  ❌ Unexpected camera config in motionEye stack: $resolved_camera_config"
                failure=1
                ;;
        esac
    done
fi

echo "[4/4] Checking host video devices..."
mapfile -t video_devices < <(compgen -G "$video_device_glob" || true)
if [[ ${#video_devices[@]} -gt 0 ]]; then
    echo "  ✅ Video device(s) found matching $video_device_glob."
else
    echo "  ❌ No video devices found matching $video_device_glob. Capture will fail."
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
