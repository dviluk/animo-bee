import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { ensureRuntimeDirectories, loadConfig } from "./config/index.js";

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

export async function startServer(config = loadConfig()) {
  const server = createAppServer(config);

  await ensureRuntimeDirectories(config);

  await new Promise((resolve) => {
    server.listen(config.server.port, config.server.host, resolve);
  });

  return server;
}

export async function main() {
  const config = loadConfig();
  await startServer(config);

  console.log(
    `animo-bee scaffold listening on http://${config.server.host}:${config.server.port}`,
  );
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
