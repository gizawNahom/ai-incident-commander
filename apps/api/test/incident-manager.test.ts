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

test("an incident record retains relevant baseline, failure, and log evidence after the simulator recovers", () => {
  let time = Date.parse("2026-08-13T12:00:00.000Z");
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date(time) });
  const manager = new IncidentManager();
  manager.observe({ type: "system", system: simulator.snapshot() });
  simulator.subscribe((event) => manager.observe(event));

  simulator.triggerBadPaymentDeployment();
  time += 2_000;
  simulator.advance();
  time += 2_000;
  simulator.advance();
  time += 2_000;
  simulator.advance();

  const beforeRecovery = manager.evidenceFor("INC-1042");
  assert.ok(beforeRecovery);
  assert.ok(beforeRecovery.metricHistories.some((history) => history.serviceId === "payment-service" && history.samples.some((sample) => (sample.latencyMs ?? 0) > 1_000)));
  assert.ok(beforeRecovery.metricHistories.some((history) => history.serviceId === "payment-service" && history.samples.some((sample) => (sample.latencyMs ?? Infinity) < 200)));
  assert.ok(beforeRecovery.logs.some((entry) => entry.serviceId === "payment-service" && /connection pool timeout/.test(entry.message)));
  assert.ok(beforeRecovery.contextServiceIds.includes("redis"));
  assert.equal(beforeRecovery.contextServiceIds.includes("notification-service"), false);

  simulator.recover();
  for (let tick = 0; tick < 4; tick += 1) {
    time += 2_000;
    simulator.advance();
  }

  const reportAfterRecovery = manager.evidenceFor("INC-1042");
  const livePayment = simulator.snapshot().services.find((service) => service.id === "payment-service");
  assert.ok(reportAfterRecovery?.metricHistories.some((history) => history.serviceId === "payment-service" && history.samples.some((sample) => (sample.latencyMs ?? 0) > 1_000)));
  assert.equal(livePayment?.health, "healthy");
  assert.ok((livePayment?.metrics.latencyMs ?? 0) < 200);
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

test("a selected-service policy waits for its configured breach duration before creating one alert instance", () => {
  const manager = new IncidentManager({
    policies: [{
      id: "orders-latency",
      name: "Orders worker latency",
      metric: "latencyMs",
      comparator: "GREATER_THAN",
      threshold: 1_000,
      unit: "ms",
      breachDurationSeconds: 10,
      severity: "SEV-2",
      enabled: true,
      scope: { type: "SELECTED_SERVICES", serviceIds: ["orders-worker"] },
    }],
  });
  const alerts: IncidentEvent[] = [];
  manager.subscribe((event) => alerts.push(event));
  const system = (timestamp: string) => ({
    type: "system" as const,
    system: {
      timestamp,
      services: [
        { id: "orders-worker", name: "Orders Worker", dependencies: [], metrics: { latencyMs: 1_400, errorRate: 0 } },
        { id: "catalog-api", name: "Catalog API", dependencies: [], metrics: { latencyMs: 1_400, errorRate: 0 } },
      ],
    },
  });

  manager.observe(system("2026-08-13T12:00:00.000Z"));
  manager.observe(system("2026-08-13T12:00:09.000Z"));
  assert.equal(alerts.length, 0);

  manager.observe(system("2026-08-13T12:00:10.000Z"));
  const alert = alerts.find((event) => event.type === "alert-triggered");
  assert.equal(alert?.type, "alert-triggered");
  if (alert?.type !== "alert-triggered") throw new Error("Expected an alert");
  assert.equal(alert.alert.serviceId, "orders-worker");
  assert.equal(alert.alert.policyId, "orders-latency");
  assert.equal(alert.alert.severity, "SEV-2");
});

test("a disabled policy never produces an alert", () => {
  const manager = new IncidentManager({
    policies: [{
      id: "disabled-latency",
      name: "Disabled latency policy",
      metric: "latencyMs",
      comparator: "GREATER_THAN",
      threshold: 1_000,
      unit: "ms",
      breachDurationSeconds: 0,
      severity: "SEV-1",
      enabled: false,
      scope: { type: "ALL_SERVICES" },
    }],
  });
  const alerts: IncidentEvent[] = [];
  manager.subscribe((event) => alerts.push(event));

  manager.observe({
    type: "system",
    system: {
      timestamp: "2026-08-13T12:00:00.000Z",
      services: [{ id: "catalog-api", name: "Catalog API", dependencies: [], metrics: { latencyMs: 1_400, errorRate: 0 } }],
    },
  });

  assert.equal(alerts.length, 0);
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
  const updatesBeforeInvestigation = changes.filter((event) => event.type === "incident-updated").length;

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
  assert.equal(changes.filter((event) => event.type === "incident-updated").length, updatesBeforeInvestigation + 1);
});

test("retains a suggested rollback and records its explicit approval lifecycle", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const manager = new IncidentManager();
  simulator.subscribe((event) => manager.observe(event));
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  manager.recordInvestigation({
    incidentId: "INC-1042",
    timestamp: "2026-08-13T12:01:00.000Z",
    hypothesis: "The deployment is the likely initiating event.",
    suggestedAction: {
      type: "ROLLBACK_DEPLOYMENT",
      targetServiceId: "payment-service",
      fromVersion: "v1.8.3",
      toVersion: "v1.8.2",
      reasoning: "The deployment immediately preceded the observed degradation.",
      evidenceIds: ["evidence-deployment"],
      risk: "medium",
    },
  });

  const proposed = manager.find("INC-1042")?.actions[0];
  assert.equal(proposed?.status, "PROPOSED");
  assert.equal(proposed?.targetServiceId, "payment-service");

  const engineer = { id: "maya-chen", name: "Maya Chen" };
  manager.takeCommand("INC-1042", "2026-08-13T12:01:01.000Z", engineer);
  const approved = manager.approveAction("INC-1042", proposed?.id ?? "", "2026-08-13T12:01:02.000Z", engineer);
  const executing = manager.beginActionExecution("INC-1042", approved.id, "2026-08-13T12:01:03.000Z");
  const completed = manager.completeAction("INC-1042", executing.id, "2026-08-13T12:01:04.000Z", "Rollback command accepted by the simulator.");

  assert.equal(completed.status, "COMPLETED");
  const timeline = manager.find("INC-1042")?.timeline ?? [];
  assert.ok(timeline.some((event) => event.type === "ACTION_APPROVED"));
  assert.ok(timeline.some((event) => event.type === "ACTION_EXECUTED"));
  assert.ok(timeline.some((event) => event.type === "ACTION_COMPLETED"));
});

test("only the engineer commanding an incident can approve its mitigation", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const manager = new IncidentManager();
  simulator.subscribe((event) => manager.observe(event));
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  manager.recordInvestigation({
    incidentId: "INC-1042",
    timestamp: "2026-08-13T12:01:00.000Z",
    hypothesis: "The deployment is the likely initiating event.",
    suggestedAction: {
      type: "ROLLBACK_DEPLOYMENT",
      targetServiceId: "payment-service",
      fromVersion: "v1.8.3",
      toVersion: "v1.8.2",
      reasoning: "The deployment immediately preceded the observed degradation.",
      evidenceIds: ["evidence-deployment"],
      risk: "medium",
    },
  });

  manager.takeCommand("INC-1042", "2026-08-13T12:01:01.000Z", { id: "maya", name: "Maya Chen" });
  const actionId = manager.find("INC-1042")?.actions[0]?.id ?? "";

  assert.throws(
    () => manager.approveAction("INC-1042", actionId, "2026-08-13T12:01:02.000Z", { id: "daniel", name: "Daniel Okafor" }),
    /Incident Commander Maya Chen must approve this action/,
  );

  assert.throws(
    () => manager.takeCommand("INC-1042", "2026-08-13T12:01:03.000Z", { id: "daniel", name: "Daniel Okafor" }),
    /A takeover reason is required/,
  );

  manager.takeCommand("INC-1042", "2026-08-13T12:01:04.000Z", { id: "daniel", name: "Daniel Okafor" }, "Maya handed off after triage");
  const approved = manager.approveAction("INC-1042", actionId, "2026-08-13T12:01:05.000Z", { id: "daniel", name: "Daniel Okafor" });
  assert.equal(approved.status, "APPROVED");
  assert.deepEqual(manager.find("INC-1042")?.commander, { id: "daniel", name: "Daniel Okafor", assignedAt: "2026-08-13T12:01:04.000Z" });
  assert.ok(manager.find("INC-1042")?.timeline.some((event) => event.type === "INCIDENT_COMMAND_ASSIGNED"));
  assert.ok(manager.find("INC-1042")?.timeline.some((event) => event.type === "INCIDENT_COMMAND_TRANSFERRED" && /Maya handed off after triage/.test(event.message)));
});

test("keeps independent incidents, monitors sustained recovery, and reopens only the matching unresolved incident", () => {
  const manager = new IncidentManager({ firstIncidentNumber: 2000 });
  const snapshot = (timestamp: string, failing: "both" | "billing" | "healthy") => ({
    type: "system" as const,
    system: {
      timestamp,
      services: [
        { id: "billing-api", name: "Billing API", dependencies: ["billing-db"], metrics: { latencyMs: failing === "both" || failing === "billing" ? 1_500 : 90, errorRate: 0 } },
        { id: "billing-db", name: "Billing DB", dependencies: [], metrics: { latencyMs: 12, errorRate: failing === "both" || failing === "billing" ? 22 : 0 } },
        { id: "shipping-api", name: "Shipping API", dependencies: ["shipping-db"], metrics: { latencyMs: failing === "both" ? 1_400 : 95, errorRate: 0 } },
        { id: "shipping-db", name: "Shipping DB", dependencies: [], metrics: { latencyMs: 10, errorRate: failing === "both" ? 18 : 0 } },
      ],
    },
  });

  manager.observe(snapshot("2026-08-13T12:00:00.000Z", "both"));
  assert.equal(manager.list().length, 2);
  const [billingIncident, shippingIncident] = manager.list();
  assert.deepEqual(billingIncident.affectedServices, ["billing-api", "billing-db"]);
  assert.deepEqual(shippingIncident.affectedServices, ["shipping-api", "shipping-db"]);
  const shippingCreationEvents = shippingIncident.timeline.filter((event) => event.type === "INCIDENT_CREATED");
  assert.equal(shippingCreationEvents.length, 1);
  assert.match(shippingCreationEvents[0]?.message ?? "", /INC-2001 created/);

  manager.observe(snapshot("2026-08-13T12:00:02.000Z", "healthy"));
  manager.observe(snapshot("2026-08-13T12:00:04.000Z", "healthy"));
  manager.observe(snapshot("2026-08-13T12:00:06.000Z", "healthy"));
  assert.equal(manager.find(billingIncident.id)?.status, "MONITORING");
  assert.equal(manager.find(shippingIncident.id)?.status, "MONITORING");

  manager.observe(snapshot("2026-08-13T12:00:08.000Z", "billing"));
  assert.equal(manager.list().length, 2);
  assert.equal(manager.find(billingIncident.id)?.status, "INVESTIGATING");
  assert.equal(manager.find(shippingIncident.id)?.status, "MONITORING");

  const engineer = { id: "maya-chen", name: "Maya Chen" };
  manager.takeCommand(shippingIncident.id, "2026-08-13T12:00:09.000Z", engineer);
  manager.resolve(shippingIncident.id, "2026-08-13T12:00:09.000Z", engineer);
  assert.equal(manager.find(shippingIncident.id)?.status, "RESOLVED");
  assert.ok(manager.find(shippingIncident.id)?.timeline.some((event) => event.type === "INCIDENT_RESOLVED"));
});
