import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.ts";
import type { IncidentInvestigator } from "../../../packages/ai/src/deterministic-investigator.ts";

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

test("alert policy API exposes seeded policies, updates valid policies, and rejects invalid policy input", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const initialResponse = await fetch(`${address}/api/alert-policies`);
    const initial = await initialResponse.json();
    assert.equal(initialResponse.status, 200);
    assert.ok(initial.policies.some((policy: { id: string; scope: { type: string } }) => policy.id === "latency-critical" && policy.scope.type === "ALL_SERVICES"));

    const update = await fetch(`${address}/api/alert-policies/latency-critical`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Payment latency safeguard",
        metric: "latencyMs",
        comparator: "GREATER_THAN",
        threshold: 900,
        breachDurationSeconds: 10,
        severity: "SEV-2",
        enabled: true,
        scope: { type: "SELECTED_SERVICES", serviceIds: ["payment-service"] },
      }),
    });
    const changed = await update.json();
    assert.equal(update.status, 200);
    assert.equal(changed.policy.threshold, 900);
    assert.deepEqual(changed.policy.scope, { type: "SELECTED_SERVICES", serviceIds: ["payment-service"] });

    const createdResponse = await fetch(`${address}/api/alert-policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Checkout error-rate safeguard",
        metric: "errorRate",
        comparator: "GREATER_THAN",
        threshold: 5,
        breachDurationSeconds: 0,
        severity: "SEV-3",
        enabled: true,
        scope: { type: "SELECTED_SERVICES", serviceIds: ["checkout-service"] },
      }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.match(created.policy.id, /^POL-/);
    assert.equal(created.policy.metric, "errorRate");

    const invalid = await fetch(`${address}/api/alert-policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metric: "latencyMs", threshold: -1 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await app.close();
  }
});

test("an alert policy scope changes which alerts the existing bad-deployment simulation can correlate", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();
  const latencyPolicy = {
    name: "Latency only on checkout",
    metric: "latencyMs",
    comparator: "GREATER_THAN",
    threshold: 1_000,
    breachDurationSeconds: 0,
    severity: "SEV-1",
    enabled: true,
    scope: { type: "SELECTED_SERVICES", serviceIds: ["checkout-service"] },
  };

  try {
    const update = await fetch(`${address}/api/alert-policies/latency-critical`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(latencyPolicy),
    });
    assert.equal(update.status, 200);
    await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    app.advance();
    app.advance();
    app.advance();

    const withoutPaymentLatency = await (await fetch(`${address}/api/incidents`)).json();
    assert.equal(withoutPaymentLatency.incidents.length, 0);

    const includePayment = await fetch(`${address}/api/alert-policies/latency-critical`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...latencyPolicy, scope: { type: "SELECTED_SERVICES", serviceIds: ["payment-service"] } }),
    });
    assert.equal(includePayment.status, 200);
    app.advance();

    const withPaymentLatency = await (await fetch(`${address}/api/incidents`)).json();
    assert.equal(withPaymentLatency.incidents.length, 1);
    assert.ok(withPaymentLatency.incidents[0].alerts.some((alert: { policyId: string; serviceId: string }) => alert.policyId === "latency-critical" && alert.serviceId === "payment-service"));
  } finally {
    await app.close();
  }
});

test("detection status explains when active alerts are waiting for correlated evidence", async () => {
  const app = createServer({ autoStart: false });
  const address = await app.listen();

  try {
    const disableLatency = await fetch(`${address}/api/alert-policies/latency-critical`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "latency above 1,000 ms",
        metric: "latencyMs",
        comparator: "GREATER_THAN",
        threshold: 1_000,
        breachDurationSeconds: 0,
        severity: "SEV-1",
        enabled: false,
        scope: { type: "ALL_SERVICES" },
      }),
    });
    assert.equal(disableLatency.status, 200);
    await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
    app.advance();
    app.advance();
    app.advance();

    const response = await fetch(`${address}/api/detection-status`);
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.state, "WAITING_FOR_CORRELATED_EVIDENCE");
    assert.equal(status.activeAlerts.length, 2);
    assert.ok(status.activeAlerts.every((alert: { metric: string }) => alert.metric === "errorRate"));
    assert.match(status.message, /waiting for.*correlated alert/i);
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

test("a failed optional AI provider falls back to the deterministic investigator without changing simulator state", async () => {
  const failingProvider: IncidentInvestigator = { investigate: async () => { throw new Error("provider unavailable"); } };
  const app = createServer({ autoStart: false, investigator: failingProvider });
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
    assert.equal(analysis.source, "deterministic");
    assert.match(analysis.fallbackReason, /AI provider unavailable/i);
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
