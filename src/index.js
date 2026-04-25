import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureRuntimeDirectories, loadConfig } from "./config/index.js";
import { CLIP_DETECTED_EVENT, startClipWatcher } from "./services/file-watcher.js";

function logClipDetected(event) {
  console.log(JSON.stringify({ event: CLIP_DETECTED_EVENT, data: event }));
}

export function createAppServer(config) {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          data: {
            status: "ok",
            service: "animo-bee",
            mode: config.mode,
            host: config.server.host,
            port: config.server.port,
            opencvEnabled: config.features.opencvEnabled,
            paths: {
              cameraSources: config.paths.cameraSources,
              processedDir: config.paths.processedDir,
              rejectedDir: config.paths.rejectedDir,
            },
          },
        }),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          data: {
            message: "animo-bee scaffold is running",
          },
        }),
      );
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        error: "Not Found",
      }),
    );
  });
}

export async function startServer(config = loadConfig(), options = {}) {
  const server = createAppServer(config);
  const startWatcher = options.startWatcher ?? true;
  const onClipDetected = options.onClipDetected ?? logClipDetected;

  await ensureRuntimeDirectories(config);

  if (startWatcher) {
    server.clipWatcher = await startClipWatcher(config, { onClipDetected });
  }

  await new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, resolve);
  });

  return server;
}

export async function stopServer(server) {
  await server.clipWatcher?.stop();

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function main() {
  const config = loadConfig();
  const server = await startServer(config);

  console.log(
    `animo-bee scaffold listening on http://${config.server.host}:${config.server.port}`,
  );

  const shutdown = async (signal) => {
    console.log(`animo-bee shutting down on ${signal}`);
    await stopServer(server);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
