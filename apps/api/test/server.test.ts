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

test("incident room assets and bounded metric history are available to investigators", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    app.advance();
    app.advance();
    app.advance();

    const room = await fetch(`${address}/incident.html?id=INC-1042`);
    const history = await fetch(`${address}/api/telemetry/history?service=payment-service`);
    const investigatorView = await fetch(`${address}/investigation-view.js`);
    const payload = await history.json();

    assert.equal(room.status, 200);
    assert.match(await room.text(), /Incident Room/);
    assert.equal(history.status, 200);
    assert.equal(investigatorView.status, 200);
    assert.match(await investigatorView.text(), /buildInvestigationView/);
    assert.equal(payload.serviceId, "payment-service");
    assert.equal(payload.samples.length, 4);
    assert.ok(payload.samples.at(-1).latencyMs > 1_000);
  } finally {
    await app.close();
  }
});

test("investigation endpoint returns grounded evidence and only proposes a mitigation", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    app.advance();
    app.advance();
    app.advance();

    const response = await fetch(`${address}/api/incidents/INC-1042/investigate`, { method: "POST" });
    const analysis = await response.json();
    const system = await (await fetch(`${address}/api/system`)).json();

    assert.equal(response.status, 200);
    assert.match(analysis.summary, /Checkout Service degradation/);
    assert.ok(analysis.knownEvidence.some((evidence: { kind: string; serviceId?: string }) => evidence.kind === "deployment" && evidence.serviceId === "payment-service"));
    assert.match(analysis.hypotheses[0].inference, /payment-service v1\.8\.3 deployment/i);
    assert.deepEqual(analysis.suggestedAction, {
      type: "ROLLBACK_DEPLOYMENT",
      targetServiceId: "payment-service",
      status: "PROPOSED",
      risk: "medium",
      rationale: "The deployment immediately preceded the observed degradation.",
    });
    assert.equal(system.scenario, "bad-payment-deployment");
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
