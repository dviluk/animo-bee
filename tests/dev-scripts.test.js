import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PROJECT_ROOT = process.cwd();
const START_MOTION_HOST_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/dev/start-motion-host.sh",
);
const VERIFY_MOTION_FLOW_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/dev/verify-motion-flow.sh",
);

function runScript(scriptPath, options = {}) {
  const { args = [], env = {} } = options;

  return spawnSync("bash", [scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function createFakeBin({
  pgrepExit = 1,
  curlExit = 0,
  pgrepMode = "fixed",
} = {}) {
  const fakeBin = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-dev-bin-"),
  );

  await writeExecutable(
    path.join(fakeBin, "meyectl"),
    `#!/usr/bin/env bash
exit 0
`,
  );

  await writeExecutable(
    path.join(fakeBin, "pgrep"),
    `#!/usr/bin/env bash
mode="${pgrepMode}"

if [[ "$mode" == "requires-f-meyectl" ]]; then
  if [[ "$*" == *"-f"* && "$*" == *"meyectl startserver"* ]]; then
    exit 0
  fi

  if [[ "$*" == *"-x"* && "$*" == *"motion"* ]]; then
    exit 1
  fi

  exit 1
fi

exit ${pgrepExit}
`,
  );

  await writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
exit ${curlExit}
`,
  );

  return fakeBin;
}

async function createTempProjectRoot() {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-dev-project-"),
  );

  await Promise.all([
    fs.mkdir(path.join(projectRoot, "runtime", "camera_1"), {
      recursive: true,
    }),
    fs.mkdir(path.join(projectRoot, "runtime", "camera_2"), {
      recursive: true,
    }),
    fs.mkdir(path.join(projectRoot, "config", "motioneye"), {
      recursive: true,
    }),
    fs.mkdir(path.join(projectRoot, "devices"), { recursive: true }),
  ]);

  return projectRoot;
}

test("start-motion-host.sh writes motionEye configs that match the runtime contract", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin();
  const configDir = path.join(projectRoot, "config", "motioneye");
  const runtimeDir = path.join(projectRoot, "runtime");
  const logsDir = path.join(runtimeDir, "logs");

  const result = runScript(START_MOTION_HOST_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
      ANIMO_BEE_RUNTIME_DIR: runtimeDir,
      ANIMO_BEE_MOTIONEYE_CONFIG_DIR: configDir,
      ANIMO_BEE_CAMERA_1_DEVICE: "/dev/video-test-0",
      ANIMO_BEE_CAMERA_2_DEVICE: "/dev/video-test-1",
    },
  });

  assert.equal(result.status, 0);

  const [motioneyeConf, motionConf, cameraOneConf, cameraTwoConf] =
    await Promise.all([
      fs.readFile(path.join(configDir, "motioneye.conf"), "utf8"),
      fs.readFile(path.join(configDir, "motion.conf"), "utf8"),
      fs.readFile(path.join(configDir, "camera-1.conf"), "utf8"),
      fs.readFile(path.join(configDir, "camera-2.conf"), "utf8"),
    ]);

  assert.match(motioneyeConf, new RegExp(`port 8765`));
  assert.match(
    motioneyeConf,
    new RegExp(`run_path ${logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(
    motioneyeConf,
    new RegExp(`log_path ${logsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(motionConf, /camera camera-1\.conf/);
  assert.match(motionConf, /camera camera-2\.conf/);
  assert.match(
    cameraOneConf,
    new RegExp(
      `target_dir ${runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/camera_1`,
    ),
  );
  assert.match(
    cameraTwoConf,
    new RegExp(
      `target_dir ${runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/camera_2`,
    ),
  );
});

test("start-motion-host.sh does not enable camera 2 unless it is explicitly configured", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin();
  const configDir = path.join(projectRoot, "config", "motioneye");
  const runtimeDir = path.join(projectRoot, "runtime");
  const cameraTwoPath = path.join(configDir, "camera-2.conf");

  await fs.writeFile(cameraTwoPath, "placeholder\n", "utf8");

  const result = runScript(START_MOTION_HOST_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
      ANIMO_BEE_RUNTIME_DIR: runtimeDir,
      ANIMO_BEE_MOTIONEYE_CONFIG_DIR: configDir,
      ANIMO_BEE_CAMERA_1_DEVICE: "/dev/video-test-0",
    },
  });

  assert.equal(result.status, 0);

  const motionConf = await fs.readFile(
    path.join(configDir, "motion.conf"),
    "utf8",
  );

  assert.match(motionConf, /camera camera-1\.conf/);
  assert.doesNotMatch(motionConf, /^camera camera-2\.conf$/m);
  assert.match(motionConf, /^# camera camera-2\.conf$/m);

  assert.equal(await fs.readFile(cameraTwoPath, "utf8"), "placeholder\n");
});

test("start-motion-host.sh refuses to start when motionEye is already running", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin({ pgrepExit: 0 });

  const result = runScript(START_MOTION_HOST_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
    },
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /already running/);
});

test("start-motion-host.sh detects a running meyectl server via command-line matching", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin({ pgrepMode: "requires-f-meyectl" });

  const result = runScript(START_MOTION_HOST_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
    },
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /already running/);
});

test("verify-motion-flow.sh fails when motionEye targets a legacy Camera1 directory", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin({ pgrepExit: 0, curlExit: 0 });
  const configDir = path.join(projectRoot, "config", "motioneye");
  const devicePath = path.join(projectRoot, "devices", "video0");

  await Promise.all([
    fs.writeFile(
      path.join(configDir, "motion.conf"),
      "camera camera-1.conf\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(configDir, "camera-1.conf"),
      `target_dir ${path.join(projectRoot, "runtime", "Camera1")}\n`,
      "utf8",
    ),
    fs.writeFile(devicePath, "", "utf8"),
  ]);

  const result = runScript(VERIFY_MOTION_FLOW_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
      ANIMO_BEE_MOTIONEYE_CONFIG_DIR: configDir,
      ANIMO_BEE_VIDEO_DEVICE_GLOB: path.join(projectRoot, "devices", "video*"),
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Expected: .*runtime\/camera_1/,
  );
});

test("verify-motion-flow.sh succeeds when active camera configs target runtime contract paths", async () => {
  const projectRoot = await createTempProjectRoot();
  const fakeBin = await createFakeBin({ pgrepExit: 0, curlExit: 0 });
  const configDir = path.join(projectRoot, "config", "motioneye");
  const devicePath = path.join(projectRoot, "devices", "video0");

  await Promise.all([
    fs.writeFile(
      path.join(configDir, "motion.conf"),
      "camera camera-1.conf\ncamera camera-2.conf\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(configDir, "camera-1.conf"),
      `target_dir ${path.join(projectRoot, "runtime", "camera_1")}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(configDir, "camera-2.conf"),
      `target_dir ${path.join(projectRoot, "runtime", "camera_2")}\n`,
      "utf8",
    ),
    fs.writeFile(devicePath, "", "utf8"),
  ]);

  const result = runScript(VERIFY_MOTION_FLOW_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROJECT_ROOT: projectRoot,
      ANIMO_BEE_MOTIONEYE_CONFIG_DIR: configDir,
      ANIMO_BEE_VIDEO_DEVICE_GLOB: path.join(projectRoot, "devices", "video*"),
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /VERIFICATION PASSED/);
});
