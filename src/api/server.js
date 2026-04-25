import { createServer } from "node:http";

const MAX_JSON_BYTES = 1024 * 1024;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function baseHealth(config) {
  return {
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
  };
}

function healthData(config, services) {
  const data = baseHealth(config);

  if (services.queueManager?.getQueueSummary) {
    data.queue = services.queueManager.getQueueSummary();
  }

  if (services.uploadWorker?.getStatus) {
    data.upload = services.uploadWorker.getStatus();
  }

  if (services.irrigationController?.getStatus) {
    data.irrigation = services.irrigationController.getStatus();
  }

  return data;
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_JSON_BYTES) {
      throw new Error("Request body exceeds 1MB.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireQueueManager(services) {
  if (!services.queueManager) {
    throw Object.assign(new Error("Queue manager is not available."), {
      statusCode: 503,
    });
  }

  return services.queueManager;
}

function errorStatus(error) {
  if (error.statusCode) {
    return error.statusCode;
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  if (error.message?.startsWith("Clip not found")) {
    return 404;
  }

  if (error.message?.startsWith("Only failed clips")) {
    return 409;
  }

  return 500;
}

function parseLimit(value) {
  const limit = Number.parseInt(value ?? "50", 10);

  if (Number.isInteger(limit) && limit > 0) {
    return limit;
  }

  return 50;
}

async function handleRequest(request, response, config, services) {
  const url = new URL(request.url, "http://localhost");
  const queueClipMatch = url.pathname.match(/^\/queue\/(\d+)$/);
  const retryMatch = url.pathname.match(/^\/uploads\/retry\/(\d+)$/);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { data: healthData(config, services) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendJson(response, 200, {
      data: {
        message: "animo-bee scaffold is running",
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/queue") {
    const queueManager = requireQueueManager(services);
    const status = url.searchParams.get("status") ?? undefined;
    const limit = parseLimit(url.searchParams.get("limit"));

    sendJson(response, 200, {
      data: {
        summary: queueManager.getQueueSummary(),
        clips: queueManager.listClips({ status, limit }),
      },
    });
    return;
  }

  if (request.method === "GET" && queueClipMatch) {
    const queueManager = requireQueueManager(services);
    const clipId = Number.parseInt(queueClipMatch[1], 10);
    const clip = queueManager.getClipById(clipId);

    if (!clip) {
      sendJson(response, 404, { error: `Clip not found: ${clipId}` });
      return;
    }

    sendJson(response, 200, {
      data: {
        clip,
        uploadAttempts: queueManager.listUploadAttempts(clipId),
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/config/opencv") {
    if (!services.configManager?.setOpenCvEnabled) {
      sendJson(response, 503, { error: "Config manager is not available." });
      return;
    }

    const payload = await readJsonBody(request);

    if (typeof payload.enabled !== "boolean") {
      sendJson(response, 422, { error: "enabled must be boolean." });
      return;
    }

    const opencvEnabled = await services.configManager.setOpenCvEnabled(
      payload.enabled,
    );

    if (services.opencvWorkerClient) {
      services.opencvWorkerClient.enabled = opencvEnabled;
    }

    sendJson(response, 200, {
      data: {
        opencvEnabled,
      },
    });
    return;
  }

  if (request.method === "POST" && retryMatch) {
    const queueManager = requireQueueManager(services);
    const clipId = Number.parseInt(retryMatch[1], 10);
    const clip = await queueManager.retryFailedUpload(clipId);

    await services.uploadWorker?.wake?.();

    sendJson(response, 200, {
      data: {
        clip,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/irrigation/trigger") {
    if (!services.irrigationController?.trigger) {
      sendJson(response, 503, {
        error: "Irrigation controller is not available.",
      });
      return;
    }

    const payload = await readJsonBody(request);
    const action = payload.action ?? "trigger";

    if (typeof action !== "string" || action.trim() === "") {
      sendJson(response, 422, { error: "action must be a non-empty string." });
      return;
    }

    const result = await services.irrigationController.trigger(
      action,
      payload.payload ?? {},
    );
    const statusCode = result.ok ? 200 : result.responseStatus ? 502 : 503;

    sendJson(response, statusCode, { data: result });
    return;
  }

  sendJson(response, 404, { error: "Not Found" });
}

export function createControlApiServer(config, services = {}) {
  return createServer((request, response) => {
    handleRequest(request, response, config, services).catch((error) => {
      sendJson(response, errorStatus(error), { error: error.message });
    });
  });
}
