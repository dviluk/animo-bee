import { ensureRuntimeDirectories, loadConfig } from "./config/index.js";

const config = loadConfig();

await ensureRuntimeDirectories(config);

console.log(
  `opencv placeholder worker idle with processedDir=${config.paths.processedDir} rejectedDir=${config.paths.rejectedDir}`,
);

const heartbeat = setInterval(() => {
  console.log(
    `opencv placeholder worker idle with cameraSources=${config.paths.cameraSources.join(",")}`,
  );
}, 60000);

function shutdown(signal) {
  clearInterval(heartbeat);
  console.log(`opencv placeholder worker shutting down on ${signal}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
