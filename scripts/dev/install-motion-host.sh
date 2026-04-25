#!/usr/bin/env bash
#
# Install native Motion and prerequisite host utilities on Ubuntu.
# This script installs motion and v4l-utils for a local development host.
# Respects active Conda environments by not running pip as root.
#

set -e

echo "Starting native Motion host installation..."

# Requirements check
if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: Please run this script as your normal user (NOT with sudo)."
  echo "The script will automatically prompt for sudo ONLY when installing system packages via apt."
  echo "This ensures motionEye installs into your active Conda environment."
  exit 1
fi

echo "Updating apt repository..."
sudo apt-get update

echo "Installing build dependencies and v4l-utils..."
sudo apt-get install -y --no-install-recommends ca-certificates curl v4l-utils ffmpeg gcc libjpeg-dev libcurl4-openssl-dev libssl-dev

echo "Downloading and installing Motion 4.7.1 for Ubuntu 24.04..."
wget -qO motion.deb "https://github.com/Motion-Project/motion/releases/download/release-4.7.1/noble_motion_4.7.1-1_amd64.deb"
sudo apt-get install -y ./motion.deb
rm -f motion.deb

echo "Disabling the default system 'motion' service to prevent it from locking the camera..."
sudo systemctl disable --now motion || true

echo "Adding current user to the 'video' group to allow reading /dev/video* devices..."
sudo usermod -aG video "$USER" || true

echo "Installing motioneye via pip into the *current* Python/Conda environment..."
python3 -m pip install --upgrade pip
python3 -m pip install motioneye

echo ""
echo "Installation complete!"
echo "Checking binary locations:"
which motion || echo "WARNING: motion binary not found in PATH"
which meyectl || echo "WARNING: meyectl binary not found in PATH (check your Conda bin path)"
which v4l2-ctl || echo "WARNING: v4l2-ctl binary not found in PATH"

echo ""
echo "NOTE: Ensure your user is in the 'video' group to access /dev/video* devices."
echo "Run 'sudo usermod -aG video \$USER' if necessary, then log out and log back in."
