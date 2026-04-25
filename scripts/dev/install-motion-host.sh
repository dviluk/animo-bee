#!/usr/bin/env bash
#
# Install native Motion and prerequisite host utilities on Ubuntu.
# This script installs motion and v4l-utils for a local development host.
#

set -e

echo "Starting native Motion host installation..."

# Requirements check
if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Please run this script as root or with sudo."
  exit 1
fi

echo "Updating apt repository..."
apt-get update

echo "Installing v4l-utils and ffmpeg..."
apt-get install -y v4l-utils ffmpeg

echo "Downloading and installing Motion 4.7.1 for Ubuntu 24.04..."
wget -qO /tmp/motion.deb "https://github.com/Motion-Project/motion/releases/download/release-4.7.1/noble_motion_4.7.1-1_amd64.deb"
apt-get install -y /tmp/motion.deb
rm -f /tmp/motion.deb

echo "Installing build dependencies for motionEye..."
apt-get install -y --no-install-recommends ca-certificates curl python3-venv python3-dev gcc libjpeg62-turbo-dev libcurl4-openssl-dev libssl-dev

echo "Creating isolated venv at /opt/motioneye to prevent conda/system conflicts..."
python3 -m venv /opt/motioneye
/opt/motioneye/bin/pip install --upgrade pip

echo "Installing motioneye via isolated pip..."
/opt/motioneye/bin/pip install motioneye

echo "Initializing motioneye setup and linking binaries..."
ln -sf /opt/motioneye/bin/meyectl /usr/local/bin/meyectl
ln -sf /opt/motioneye/bin/motioneye_init /usr/local/bin/motioneye_init
/usr/local/bin/motioneye_init

echo ""
echo "Installation complete!"
echo "Checking binary locations:"
which motion || echo "WARNING: motion binary not found in PATH"
which meyectl || echo "WARNING: meyectl binary not found in PATH"
which v4l2-ctl || echo "WARNING: v4l2-ctl binary not found in PATH"

echo ""
echo "NOTE: If you plan to run Motion as a non-root user, ensure your user is in the 'video' group to access /dev/video* devices."
echo "Run 'sudo usermod -aG video \$USER' if necessary, then log out and log back in."
echo ""
echo "To verify the camera devices, run: v4l2-ctl --list-devices"
