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

echo "Installing motion and v4l-utils..."
apt-get install -y motion v4l-utils ffmpeg

echo ""
echo "Installation complete!"
echo "Checking binary locations:"
which motion || echo "WARNING: motion binary not found in PATH"
which v4l2-ctl || echo "WARNING: v4l2-ctl binary not found in PATH"

echo ""
echo "NOTE: If you plan to run Motion as a non-root user, ensure your user is in the 'video' group to access /dev/video* devices."
echo "Run 'sudo usermod -aG video \$USER' if necessary, then log out and log back in."
echo ""
echo "To verify the camera devices, run: v4l2-ctl --list-devices"
