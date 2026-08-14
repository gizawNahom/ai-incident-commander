import assert from "node:assert/strict";
import test from "node:test";

import { IncidentManager, type IncidentEvent } from "../src/incident-manager.ts";
import { TelemetrySimulator } from "../src/simulator.ts";

test("the configured demo topology still creates an evidence-backed incident", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const manager = new IncidentManager();
  const changes: IncidentEvent[] = [];
  manager.subscribe((event) => changes.push(event));
  simulator.subscribe((event) => manager.observe(event));

  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const incident = manager.list()[0];
  assert.equal(manager.list().length, 1);
  assert.equal(incident.id, "INC-1042");
  assert.equal(incident.title, "Checkout Service degradation");
  assert.equal(incident.severity, "SEV-1");
  assert.equal(incident.status, "DETECTED");
  assert.deepEqual(incident.affectedServices, ["checkout-service", "payment-service"]);
  assert.equal(incident.alerts.length, 2);
  assert.ok(incident.timeline.some((event) => event.type === "DEPLOYMENT" && event.message.includes("v1.8.3")));
  assert.ok(incident.timeline.some((event) => event.type === "ALERT_TRIGGERED" && event.message.includes("Payment Service latency")));
  assert.ok(incident.timeline.some((event) => event.type === "INCIDENT_CREATED"));
  assert.equal(changes.filter((event) => event.type === "incident-created").length, 1);
});

test("any connected services with distinct threshold breaches create an incident without service-name rules", () => {
  const manager = new IncidentManager();
  manager.observe({ type: "deployment", timestamp: "2026-08-13T12:00:00.000Z", serviceId: "orders-worker", message: "orders-worker v9 deployed" });
  manager.observe({
    type: "system",
    system: {
      timestamp: "2026-08-13T12:00:20.000Z",
      services: [
        { id: "storefront", name: "Storefront", dependencies: ["orders-worker"], metrics: { latencyMs: 100, errorRate: 18 } },
        { id: "orders-worker", name: "Orders Worker", dependencies: ["queue-store"], metrics: { latencyMs: 1_400, errorRate: 2 } },
        { id: "queue-store", name: "Queue Store", dependencies: [], metrics: { latencyMs: 15, errorRate: 0 } },
      ],
    },
  });

  const incident = manager.list()[0];
  assert.equal(manager.list().length, 1);
  assert.equal(incident.title, "Storefront degradation");
  assert.deepEqual(incident.affectedServices, ["orders-worker", "storefront"]);
  assert.ok(incident.timeline.some((event) => event.type === "DEPLOYMENT" && event.serviceId === "orders-worker"));
});

test("one threshold breach alone does not create an incident", () => {
  const manager = new IncidentManager();
  manager.observe({
    type: "system",
    system: {
      timestamp: "2026-08-13T12:00:00.000Z",
      services: [
        { id: "catalog-api", name: "Catalog API", dependencies: ["catalog-db"], metrics: { latencyMs: 1_400, errorRate: 3 } },
        { id: "catalog-db", name: "Catalog DB", dependencies: [], metrics: { latencyMs: 10, errorRate: 0 } },
      ],
    },
  });

  assert.equal(manager.list().length, 0);
});

test("threshold breaches on unrelated dependency paths do not merge into one incident", () => {
  const manager = new IncidentManager();
  manager.observe({
    type: "system",
    system: {
      timestamp: "2026-08-13T12:00:00.000Z",
      services: [
        { id: "billing-api", name: "Billing API", dependencies: ["billing-db"], metrics: { latencyMs: 1_500, errorRate: 1 } },
        { id: "billing-db", name: "Billing DB", dependencies: [], metrics: { latencyMs: 9, errorRate: 0 } },
        { id: "shipping-api", name: "Shipping API", dependencies: ["shipping-db"], metrics: { latencyMs: 140, errorRate: 19 } },
        { id: "shipping-db", name: "Shipping DB", dependencies: [], metrics: { latencyMs: 11, errorRate: 0 } },
      ],
    },
  });

  assert.equal(manager.list().length, 0);
});

test("records deterministic investigation activity in the incident timeline", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const manager = new IncidentManager();
  const changes: IncidentEvent[] = [];
  manager.subscribe((event) => changes.push(event));
  simulator.subscribe((event) => manager.observe(event));
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  manager.recordInvestigation({
    incidentId: "INC-1042",
    timestamp: "2026-08-13T12:01:00.000Z",
    hypothesis: "The payment deployment is the likely initiating event.",
    suggestedAction: "Rollback payment-service v1.8.3",
  });

  const timeline = manager.find("INC-1042")?.timeline ?? [];
  assert.ok(timeline.some((event) => event.type === "AI_ANALYSIS_STARTED"));
  assert.ok(timeline.some((event) => event.type === "AI_HYPOTHESIS_GENERATED" && /likely initiating event/.test(event.message)));
  assert.ok(timeline.some((event) => event.type === "ACTION_SUGGESTED" && /Rollback/.test(event.message)));
  assert.equal(changes.filter((event) => event.type === "incident-updated").length, 1);
});
