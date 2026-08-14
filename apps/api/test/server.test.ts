import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.ts";

test("health endpoint returns an operational snapshot with a request id", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const response = await fetch(`${address}/api/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "ai-incident-commander-api");
    assert.ok(response.headers.get("x-request-id"));
  } finally {
    await app.close();
  }
});

test("telemetry endpoint streams simulator updates as SSE", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    const reader = response.body?.getReader();
    assert.ok(reader);
    app.advance();
    const { value } = await reader.read();
    controller.abort();

    assert.match(new TextDecoder().decode(value), /event: telemetry/);
  } finally {
    await app.close();
  }
});
