# Ubuntu Motion Host Setup

**Host Baseline:**

- OS: Ubuntu 24.04.4 LTS (Noble Numbat) x86_64
- Docker: 29.4.0
- Docker Compose: v2.40.3
- Motion: 4.7.1
- motionEye: Installed via pip in the active Conda environment and running in user-space.

**Host-to-Container Directory Mapping:**

- `./scripts/dev/start-motion-host.sh` generates a local `config/motioneye/` stack and pins `camera-1.conf` to `./runtime/camera_1`.
- Camera 2 is opt-in only. By default `motion.conf` keeps `# camera camera-2.conf` commented out. Set `ANIMO_BEE_CAMERA_2_DEVICE=/dev/video1` before running the script if you want it to generate and enable `camera-2.conf`.
- The same script points motionEye runtime artifacts and logs to `./runtime/logs`.
- Dockerized `animo-bee` mounts `./runtime` to `/app/runtime` and reads the clips synchronously.
- motionEye serves the Web UI at `http://localhost:8765`. The internal Motion webcontrol port remains `7999`.

**Operational Sequence:**

1. Start the host motionEye service (this generates the local config and writes captures into `runtime/`):
   ```bash
   ./scripts/dev/start-motion-host.sh
   ```
   If it reports that motionEye is already running, stop the previous instance with `./scripts/dev/stop-motion-host.sh` and start again.
2. Start the Dockerized `animo-bee` environment (this attaches to `runtime/`):
   ```bash
   ./scripts/dev/start-dev.sh
   ```
   This command stays attached to container logs until you stop it with `Ctrl+C`.
3. Run the E2E verification script to ensure successful capture, visibility, and architecture alignment:
   ```bash
   ./scripts/dev/verify-motion-flow.sh
   ```
   The verifier checks the live motionEye config, confirms that each active camera config targets the contract paths, and then checks the Docker app health.

**Failure Path Considerations:**

- Missing `/dev/video*` devices due to VM or WSL isolation will be flagged by the verification script. Run `sudo chmod 666 /dev/video*` or assign the user to the `video` group if permissions fail.
- A mismatch such as `runtime/Camera1` versus `runtime/camera_1` now fails verification instead of passing silently.
