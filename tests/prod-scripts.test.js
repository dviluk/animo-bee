import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PROJECT_ROOT = process.cwd();
const BOOTSTRAP_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/prod/bootstrap-native.sh",
);
const CREATE_LAYOUT_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/prod/create-runtime-layout.sh",
);
const HEALTHCHECK_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/prod/healthcheck.sh",
);
const START_PROD_STACK_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/prod/start-prod-stack.sh",
);
const STOP_PROD_STACK_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts/prod/stop-prod-stack.sh",
);
const PROD_COMPOSE_FILE = path.join(PROJECT_ROOT, "docker-compose.prod.yml");

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

async function prepareRuntimeRoot() {
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-prod-"),
  );

  const requiredDirectories = [
    path.join(runtimeRoot, "data/camera_1"),
    path.join(runtimeRoot, "data/camera_2"),
    path.join(runtimeRoot, "data/processed"),
    path.join(runtimeRoot, "data/rejected"),
    path.join(runtimeRoot, "logs"),
    path.join(runtimeRoot, "db"),
  ];

  await Promise.all(
    requiredDirectories.map((directoryPath) =>
      fs.mkdir(directoryPath, { recursive: true }),
    ),
  );

  return runtimeRoot;
}

async function createFakeToolchain(mode) {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "animo-bee-tools-"));

  await writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

echo "Docker version 0.0.0"
exit 0
`,
  );

  await writeExecutable(
    path.join(fakeBin, "pgrep"),
    `#!/usr/bin/env bash
exit 1
`,
  );

  await writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
exit 0
`,
  );

  if (mode === "motioneye-present") {
    await writeExecutable(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
if [[ "$1" == "list-unit-files" ]]; then
  echo "motioneye.service enabled"
  exit 0
fi

if [[ "$1" == "is-active" ]]; then
  exit 0
fi

exit 0
`,
    );
  } else {
    await writeExecutable(
      path.join(fakeBin, "systemctl"),
      `#!/usr/bin/env bash
if [[ "$1" == "list-unit-files" ]]; then
  exit 0
fi

if [[ "$1" == "is-active" ]]; then
  exit 3
fi

exit 0
`,
    );
  }

  return fakeBin;
}

test("bootstrap-native.sh supports --help", () => {
  const result = runScript(BOOTSTRAP_SCRIPT, { args: ["--help"] });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: .*bootstrap-native\.sh/);
});

test("create-runtime-layout.sh builds the expected layout and is idempotent", async () => {
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-layout-"),
  );
  const dbFileName = "integration.sqlite";

  const env = {
    ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
    ANIMO_BEE_DB_FILE: dbFileName,
    ANIMO_BEE_SKIP_MOUNT_CHECK: "1",
  };

  const firstRun = runScript(CREATE_LAYOUT_SCRIPT, { env });
  const secondRun = runScript(CREATE_LAYOUT_SCRIPT, { env });

  assert.equal(firstRun.status, 0);
  assert.equal(secondRun.status, 0);
  assert.match(firstRun.stdout, /Runtime layout is ready\./);

  const expectedPaths = [
    path.join(runtimeRoot, "data/camera_1"),
    path.join(runtimeRoot, "data/camera_2"),
    path.join(runtimeRoot, "data/processed"),
    path.join(runtimeRoot, "data/rejected"),
    path.join(runtimeRoot, "logs"),
    path.join(runtimeRoot, "db"),
    path.join(runtimeRoot, "db", dbFileName),
  ];

  const stats = await Promise.all(
    expectedPaths.map((target) => fs.stat(target)),
  );

  stats.slice(0, 6).forEach((entry) => assert.equal(entry.isDirectory(), true));
  assert.equal(stats[6].isFile(), true);
});

test("healthcheck.sh fails when motionEye is absent", async () => {
  const runtimeRoot = await prepareRuntimeRoot();
  const fakeBin = await createFakeToolchain("motioneye-missing");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");

  await fs.writeFile(composeFile, "services: {}\n", "utf8");

  const result = runScript(HEALTHCHECK_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_PATH: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_HEALTH_URL: "http://127.0.0.1:39999/health",
    },
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /motionEye is not detected/);
});

test("healthcheck.sh fails when compose file is absent", async () => {
  const runtimeRoot = await prepareRuntimeRoot();
  const fakeBin = await createFakeToolchain("motioneye-present");

  const result = runScript(HEALTHCHECK_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_PATH: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      ANIMO_BEE_PROD_COMPOSE_FILE: path.join(runtimeRoot, "missing.prod.yml"),
      ANIMO_BEE_HEALTH_URL: "http://127.0.0.1:39999/health",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Production compose file not found/,
  );
});

test("start-prod-stack.sh enables the optional OpenCV profile", async () => {
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-prod-"),
  );
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");
  const envFile = path.join(runtimeRoot, "stack.env");
  const dockerLog = path.join(runtimeRoot, "docker.log");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    fs.writeFile(
      envFile,
      "APP_MODE=production\nOPENCV_WORKER_URL=http://127.0.0.1:9999/decision\n",
      "utf8",
    ),
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${dockerLog}"

if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" && "$*" == *" ps"* ]]; then
  echo "app"
  echo "opencv-worker"
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

exit 0
`,
    ),
  ]);

  const result = runScript(START_PROD_STACK_SCRIPT, {
    args: ["--with-opencv", "--no-build"],
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_ENV_FILE: envFile,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_FILE: "integration.sqlite",
      ANIMO_BEE_SKIP_MOUNT_CHECK: "1",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /OPENCV_ENABLED=true/);

  const dockerInvocations = await fs.readFile(dockerLog, "utf8");
  assert.match(dockerInvocations, /--profile opencv/);

  await fs.stat(path.join(runtimeRoot, "data", "camera_1"));
  await fs.stat(path.join(runtimeRoot, "db", "integration.sqlite"));
});

test("start-prod-stack.sh rejects OpenCV profile without worker contract", async () => {
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-prod-"),
  );
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");
  const envFile = path.join(runtimeRoot, "stack.env");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    fs.writeFile(envFile, "APP_MODE=production\n", "utf8"),
  ]);

  const result = runScript(START_PROD_STACK_SCRIPT, {
    args: ["--with-opencv", "--no-build"],
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_ENV_FILE: envFile,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_FILE: "integration.sqlite",
      ANIMO_BEE_SKIP_MOUNT_CHECK: "1",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /requires OPENCV_WORKER_URL or OPENCV_WORKER_COMMAND/,
  );
});

test("stop-prod-stack.sh forwards volume cleanup option", async () => {
  const runtimeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "animo-bee-stop-"),
  );
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");
  const envFile = path.join(runtimeRoot, "stack.env");
  const dockerLog = path.join(runtimeRoot, "docker.log");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    fs.writeFile(envFile, "APP_MODE=production\n", "utf8"),
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${dockerLog}"

if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

exit 0
`,
    ),
  ]);

  const result = runScript(STOP_PROD_STACK_SCRIPT, {
    args: ["--volumes"],
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_ENV_FILE: envFile,
    },
  });

  assert.equal(result.status, 0);

  const dockerInvocations = await fs.readFile(dockerLog, "utf8");
  assert.match(dockerInvocations, /down --remove-orphans --volumes/);
});

test("healthcheck.sh fails when production compose cannot be rendered", async () => {
  const runtimeRoot = await prepareRuntimeRoot();
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");
  const envFile = path.join(runtimeRoot, "stack.env");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    fs.writeFile(envFile, "APP_MODE=production\n", "utf8"),
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" && "$*" == *" config"* ]]; then
  exit 1
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

exit 0
`,
    ),
  ]);

  const result = runScript(HEALTHCHECK_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_PATH: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_ENV_FILE: envFile,
      ANIMO_BEE_HEALTH_URL: "http://127.0.0.1:39999/health",
    },
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /could not be rendered/);
});

test("healthcheck.sh validates health and queue payload structures", async () => {
  const runtimeRoot = await prepareRuntimeRoot();
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" && "$*" == *" ps "* ]]; then
  echo "app"
  echo "opencv-worker"
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

exit 0
`,
    ),
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
url="\${@: -1}"

if [[ "$url" == *"/queue" ]]; then
  echo '{"data":{"summary":{"total":0},"clips":[]}}'
  exit 0
fi

echo '{"data":{"status":"ok","service":"animo-bee","opencv":{"mode":"shadow","enabled":true,"failOpen":true,"retainRejectedFiles":true},"queue":{"total":0},"upload":{"running":false}}}'
exit 0
`,
    ),
  ]);

  const result = runScript(HEALTHCHECK_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_PATH: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_HEALTH_URL: "http://127.0.0.1:3001/health",
      OPENCV_MODE: "shadow",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /OpenCV mode is valid: shadow/);
  assert.match(result.stdout, /reports OpenCV mode shadow/);
  assert.match(result.stdout, /includes OpenCV failOpen status/);
  assert.match(result.stdout, /includes OpenCV retainRejectedFiles status/);
  assert.match(result.stdout, /Local health endpoint includes queue summary/);
  assert.match(
    result.stdout,
    /Local health endpoint includes upload worker status/,
  );
  assert.match(result.stdout, /Local queue endpoint exposes summary and clips/);
});

test("healthcheck.sh fails when OpenCV mode does not match health payload", async () => {
  const runtimeRoot = await prepareRuntimeRoot();
  const fakeBin = await createFakeToolchain("motioneye-present");
  const composeFile = path.join(runtimeRoot, "docker-compose.prod.yml");

  await Promise.all([
    fs.writeFile(composeFile, "services: {}\n", "utf8"),
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  echo "Docker Compose version v2.0.0"
  exit 0
fi

if [[ "$1" == "compose" && "$*" == *" ps "* ]]; then
  echo "app"
  echo "opencv-worker"
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  exit 0
fi

exit 0
`,
    ),
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
url="\${@: -1}"

if [[ "$url" == *"/queue" ]]; then
  echo '{"data":{"summary":{"total":0},"clips":[]}}'
  exit 0
fi

echo '{"data":{"status":"ok","service":"animo-bee","opencv":{"mode":"shadow","enabled":true,"failOpen":true,"retainRejectedFiles":true},"queue":{"total":0},"upload":{"running":false}}}'
exit 0
`,
    ),
  ]);

  const result = runScript(HEALTHCHECK_SCRIPT, {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      ANIMO_BEE_RUNTIME_ROOT: runtimeRoot,
      ANIMO_BEE_DB_PATH: path.join(runtimeRoot, "db", "orchestrator.sqlite"),
      ANIMO_BEE_PROD_COMPOSE_FILE: composeFile,
      ANIMO_BEE_HEALTH_URL: "http://127.0.0.1:3001/health",
      OPENCV_MODE: "enforce",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /does not match expected mode: enforce/,
  );
});

test("docker-compose.prod.yml forwards phase 5 runtime env keys into the app service", async () => {
  const composeFile = await fs.readFile(PROD_COMPOSE_FILE, "utf8");

  [
    /OPENCV_WORKER_COMMAND:\s*\$\{OPENCV_WORKER_COMMAND:-\}/,
    /OPENCV_WORKER_ARGS:\s*\$\{OPENCV_WORKER_ARGS:-\[\]\}/,
    /OPENCV_WORKER_URL:\s*\$\{OPENCV_WORKER_URL:-\}/,
    /UPLOAD_ENABLED:\s*\$\{UPLOAD_ENABLED:-false\}/,
    /UPLOAD_URL:\s*\$\{UPLOAD_URL:-\}/,
    /UPLOAD_HEADERS_JSON:\s*\$\{UPLOAD_HEADERS_JSON:-\{\}\}/,
    /UPLOAD_MAX_ATTEMPTS:\s*\$\{UPLOAD_MAX_ATTEMPTS:-3\}/,
    /UPLOAD_POLL_INTERVAL_MS:\s*\$\{UPLOAD_POLL_INTERVAL_MS:-5000\}/,
    /UPLOAD_RETRY_DELAY_MS:\s*\$\{UPLOAD_RETRY_DELAY_MS:-30000\}/,
    /UPLOAD_TIMEOUT_MS:\s*\$\{UPLOAD_TIMEOUT_MS:-60000\}/,
    /IRRIGATION_ENABLED:\s*\$\{IRRIGATION_ENABLED:-false\}/,
    /IRRIGATION_TRIGGER_URL:\s*\$\{IRRIGATION_TRIGGER_URL:-\}/,
    /IRRIGATION_HEADERS_JSON:\s*\$\{IRRIGATION_HEADERS_JSON:-\{\}\}/,
    /IRRIGATION_TIMEOUT_MS:\s*\$\{IRRIGATION_TIMEOUT_MS:-10000\}/,
  ].forEach((pattern) => {
    assert.match(composeFile, pattern);
  });
});
