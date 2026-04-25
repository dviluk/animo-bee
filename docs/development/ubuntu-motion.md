# Ubuntu Motion Host Setup

**Host Baseline:**

- OS: Ubuntu 24.04.4 LTS (Noble Numbat) x86_64
- Docker: 29.4.0
- Docker Compose: v2.40.3
- Motion: candidate 4.6.0-1ubuntu2 (apt)
- motionEye: Not available in apt, proceeding with native Motion only.
- Devices: No `/dev/video*` devices currently visible on the host environment (expected for virtual/remote baseline).

**Host-to-Container Directory Mapping:**

- Native Motion records to `./runtime/camera_1` and `./runtime/camera_2` which are shared directly into the Docker environment.
- Dockerized `animo-bee` mounts `./runtime` to `/app/runtime` and reads the clips synchronously.
- **Startup Sequence:** Host Motion must be started first (`./scripts/dev/start-motion-host.sh`), followed by the Dockerized `animo-bee` app (`./scripts/dev/start-dev.sh`).
