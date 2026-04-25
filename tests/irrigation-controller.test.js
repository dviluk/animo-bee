import assert from "node:assert/strict";
import test from "node:test";

import { IrrigationController } from "../src/services/irrigation-controller.js";

function buildConfig(overrides = {}) {
  return {
    irrigation: {
      enabled: false,
      triggerUrl: null,
      headers: {},
      timeoutMs: 200,
      ...(overrides.irrigation ?? {}),
    },
    ...overrides,
  };
}

test("trigger returns not configured error and records the event", async () => {
  const events = [];
  const controller = new IrrigationController(buildConfig(), {
    recordIrrigationEvent: async (event) => {
      events.push(event);
    },
  });

  const result = await controller.trigger("open", { zone: 1 });

  assert.deepEqual(result, {
    ok: false,
    error: "Irrigation trigger URL is not configured.",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "open");
  assert.deepEqual(events[0].payload, { zone: 1 });
  assert.deepEqual(events[0].result, result);
});

test("trigger calls upstream endpoint and truncates long response bodies", async () => {
  const events = [];
  const controller = new IrrigationController(
    buildConfig({
      irrigation: {
        enabled: true,
        triggerUrl: "https://example.test/irrigation",
        headers: {
          authorization: "Bearer token",
        },
      },
    }),
    {
      recordIrrigationEvent: async (event) => {
        events.push(event);
      },
    },
    {
      fetch: async (url, options) => {
        assert.equal(url, "https://example.test/irrigation");
        assert.equal(options.method, "POST");
        assert.equal(options.headers.authorization, "Bearer token");

        return {
          ok: true,
          status: 200,
          text: async () => "x".repeat(3000),
        };
      },
    },
  );

  const result = await controller.trigger("close", { zone: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.responseStatus, 200);
  assert.equal(result.responseBody.length, 2000);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "close");
  assert.deepEqual(events[0].payload, { zone: 4 });
});

test("trigger records upstream fetch failures", async () => {
  const events = [];
  const controller = new IrrigationController(
    buildConfig({
      irrigation: {
        enabled: true,
        triggerUrl: "https://example.test/irrigation",
      },
    }),
    {
      recordIrrigationEvent: async (event) => {
        events.push(event);
      },
    },
    {
      fetch: async () => {
        throw new Error("upstream offline");
      },
    },
  );

  const result = await controller.trigger("open", { zone: 8 });

  assert.deepEqual(result, {
    ok: false,
    error: "upstream offline",
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].result, result);
});
