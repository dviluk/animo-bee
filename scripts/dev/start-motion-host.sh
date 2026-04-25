#!/usr/bin/env bash
#
# Start script for native motionEye on Ubuntu host.
# Generates a deterministic local motionEye configuration that writes to runtime/.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="${ANIMO_BEE_PROJECT_ROOT:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
RUNTIME_DIR="${ANIMO_BEE_RUNTIME_DIR:-$PROJECT_ROOT/runtime}"
MOTIONEYE_CONFIG_DIR="${ANIMO_BEE_MOTIONEYE_CONFIG_DIR:-$PROJECT_ROOT/config/motioneye}"
MOTIONEYE_CONF="$MOTIONEYE_CONFIG_DIR/motioneye.conf"
MOTION_CONF="$MOTIONEYE_CONFIG_DIR/motion.conf"
MOTIONEYE_RUN_DIR="${ANIMO_BEE_MOTIONEYE_RUN_DIR:-$RUNTIME_DIR/logs}"
MOTIONEYE_LOG_DIR="${ANIMO_BEE_MOTIONEYE_LOG_DIR:-$RUNTIME_DIR/logs}"
MOTIONEYE_UI_PORT="${ANIMO_BEE_MOTIONEYE_UI_PORT:-8765}"
MOTION_CONTROL_PORT="${ANIMO_BEE_MOTION_CONTROL_PORT:-7999}"
CAMERA_1_DEVICE="${ANIMO_BEE_CAMERA_1_DEVICE:-/dev/video0}"
CAMERA_2_DEVICE="${ANIMO_BEE_CAMERA_2_DEVICE:-}"

build_relayevent_lines() {
    local relayevent_script="$1"

    if [[ -z "$relayevent_script" ]]; then
        return 0
    fi

    cat <<EOF
on_event_start $relayevent_script "./motioneye.conf" start %t
on_event_end $relayevent_script "./motioneye.conf" stop %t
on_movie_end $relayevent_script "./motioneye.conf" movie_end %t %f
on_picture_save $relayevent_script "./motioneye.conf" picture_save %t %f
EOF
}

motioneye_running() {
    pgrep -f "meyectl startserver" >/dev/null || pgrep -x "motion" >/dev/null
}

write_camera_config() {
    local config_path="$1"
    local camera_id="$2"
    local camera_name="$3"
    local video_device="$4"
    local target_dir="$5"
    local stream_port="$6"
    local relayevent_lines="$7"

    cat > "$config_path" <<EOF
# @enabled on
# @id $camera_id
# @storage_device custom-path
# @preserve_movies 0
# @lang en


width 1280
height 720
camera_name $camera_name
auto_brightness off
framerate 30
target_dir $target_dir
stream_localhost off
stream_port $stream_port
stream_maxrate 30
stream_quality 85
stream_motion off
stream_auth_method 0
text_left $camera_name
text_right %Y-%m-%d\n%T
threshold 1500
noise_tune on
noise_level 32
minimum_motion_frames 20
picture_output off
movie_filename %Y-%m-%d/%H-%M-%S
movie_output on
movie_max_time 60
movie_codec mkv
movie_quality 45
$relayevent_lines
stream_authentication user:
video_device $video_device
EOF
}

echo "=== Starting Native motionEye Host (Conda) ==="

if ! command -v meyectl >/dev/null; then
    echo "ERROR: meyectl binary not found in your Conda PATH."
    echo "Run ./install-motion-host.sh without sudo to install via pip."
    exit 1
fi

if motioneye_running; then
    echo "ERROR: motionEye or motion is already running."
    echo "Run ./scripts/dev/stop-motion-host.sh before starting a new instance."
    exit 1
fi

mkdir -p "$RUNTIME_DIR/camera_1" "$RUNTIME_DIR/camera_2" "$MOTIONEYE_RUN_DIR" "$MOTIONEYE_LOG_DIR"
mkdir -p "$MOTIONEYE_CONFIG_DIR"

relayevent_script=""
if command -v python3 >/dev/null; then
    relayevent_script="$(python3 - <<'PY' 2>/dev/null || true
import importlib.util
import pathlib

spec = importlib.util.find_spec("motioneye")
if spec and spec.origin:
    print(pathlib.Path(spec.origin).resolve().parent / "scripts" / "relayevent.sh")
PY
)"
fi

relayevent_lines="$(build_relayevent_lines "$relayevent_script")"

if [[ ! -e "$CAMERA_1_DEVICE" ]]; then
    echo "WARNING: $CAMERA_1_DEVICE is not present. motionEye may start without an active camera feed."
fi

if [[ -n "$CAMERA_2_DEVICE" && ! -e "$CAMERA_2_DEVICE" ]]; then
    echo "WARNING: $CAMERA_2_DEVICE is not present. Camera 2 will be configured but may fail to open."
fi

cat > "$MOTIONEYE_CONF" <<EOF
conf_path $MOTIONEYE_CONFIG_DIR
run_path $MOTIONEYE_RUN_DIR
log_path $MOTIONEYE_LOG_DIR
media_path $RUNTIME_DIR
port $MOTIONEYE_UI_PORT
EOF

cat > "$MOTION_CONF" <<EOF
setup_mode off
webcontrol_port $MOTION_CONTROL_PORT
webcontrol_interface 1
webcontrol_localhost on
webcontrol_parms 2

camera camera-1.conf
EOF

write_camera_config \
    "$MOTIONEYE_CONFIG_DIR/camera-1.conf" \
    "1" \
    "camera_1" \
    "$CAMERA_1_DEVICE" \
    "$RUNTIME_DIR/camera_1" \
    "9081" \
    "$relayevent_lines"

if [[ -n "$CAMERA_2_DEVICE" ]]; then
    cat >> "$MOTION_CONF" <<EOF
camera camera-2.conf
EOF

    write_camera_config \
        "$MOTIONEYE_CONFIG_DIR/camera-2.conf" \
        "2" \
        "camera_2" \
        "$CAMERA_2_DEVICE" \
        "$RUNTIME_DIR/camera_2" \
        "9082" \
        "$relayevent_lines"
else
    cat >> "$MOTION_CONF" <<EOF
# camera camera-2.conf
EOF
fi

if [ "${1:-}" = "-d" ] || [ "${1:-}" = "--daemon" ]; then
    echo "Starting meyectl in background..."
    nohup meyectl startserver -c "$MOTIONEYE_CONF" >/dev/null 2>&1 &
    echo "motionEye started with PID $!"
else
    echo "Starting meyectl in foreground. Press Ctrl+C to stop."
    exec meyectl startserver -c "$MOTIONEYE_CONF"
fi

echo "motionEye started! Access the Web UI at http://localhost:$MOTIONEYE_UI_PORT"
