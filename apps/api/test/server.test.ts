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

test("topology module is served to the live dashboard", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const response = await fetch(`${address}/topology.js`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /buildTopologyGraph/);
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

test("simulator controls trigger a bad deployment and expose propagated state through the snapshot API", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const trigger = await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    assert.equal(trigger.status, 202);
    app.advance();
    app.advance();
    app.advance();

    const response = await fetch(`${address}/api/system`);
    const system = await response.json();
    const payment = system.services.find((service: { id: string }) => service.id === "payment-service");

    assert.equal(system.scenario, "bad-payment-deployment");
    assert.equal(payment.version, "v1.8.3");
    assert.equal(payment.health, "critical");
  } finally {
    await app.close();
  }
});

test("incidents API exposes the incident created from correlated simulator alerts", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    app.advance();
    app.advance();
    app.advance();

    const response = await fetch(`${address}/api/incidents`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.incidents.length, 1);
    assert.equal(payload.incidents[0].id, "INC-1042");
    assert.equal(payload.incidents[0].title, "Checkout Service degradation");
    assert.equal(payload.incidents[0].alerts.length, 2);
  } finally {
    await app.close();
  }
});
