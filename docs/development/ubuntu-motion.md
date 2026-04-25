# Ubuntu Motion Host Setup

**Host Baseline:**

- OS: Ubuntu 24.04.4 LTS (Noble Numbat) x86_64
- Docker: 29.4.0
- Docker Compose: v2.40.3
- Motion: candidate 4.6.0-1ubuntu2 (apt)
- motionEye: Installed via pip under Conda Python 3.9. Running in user-space.

**Host-to-Container Directory Mapping:**

- Native Motion records to `./runtime/camera_1` and `./runtime/camera_2` which are shared directly into the Docker environment.
- Dockerized `animo-bee` mounts `./runtime` to `/app/runtime` and reads the clips synchronously.

**Operational Sequence:**

1. Start the host Motion service (this sets up local cameras and writes to `runtime/`):
   ```bash
   ./scripts/dev/start-motion-host.sh
   ```
2. Start the Dockerized `animo-bee` environment (this attaches to `runtime/`):
   ```bash
   ./scripts/dev/start-dev.sh
   ```
3. Run the E2E verification script to ensure successful capture, visibility, and architecture alignment:
   ```bash
   ./scripts/dev/verify-motion-flow.sh
   ```

**Failure Path Considerations:**
- Missing `/dev/video*` devices due to VM or WSL isolation will be flagged by the verification script. Run `sudo chmod 666 /dev/video*` or assign the user to the `video` group if permissions fail.
