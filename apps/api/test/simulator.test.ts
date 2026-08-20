import assert from "node:assert/strict";
import test from "node:test";

import { TelemetrySimulator, type SimulatorEvent } from "../src/simulator.ts";

test("the healthy simulator publishes an API Gateway latency sample when it advances", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const samples: SimulatorEvent[] = [];
  simulator.subscribe((sample) => samples.push(sample));

  simulator.advance();

  const telemetry = samples.filter((event) => event.type === "telemetry");
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].serviceId, "api-gateway");
  assert.equal(telemetry[0].metric, "latency_ms");
  assert.ok(telemetry[0].value >= 80 && telemetry[0].value <= 130);
});

test("the healthy simulator exposes connected services with healthy baseline metrics", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });

  const system = simulator.snapshot();
  const checkout = system.services.find((service) => service.id === "checkout-service");
  const payment = system.services.find((service) => service.id === "payment-service");
  const redis = system.services.find((service) => service.id === "redis");

  assert.equal(system.services.length, 9);
  assert.equal(system.scenario, "healthy");
  assert.equal(checkout?.health, "healthy");
  assert.deepEqual(checkout?.dependencies, ["inventory-service", "payment-service"]);
  assert.deepEqual(payment?.dependencies, ["redis", "kafka", "postgresql"]);
  assert.equal(redis?.health, "healthy");
});

test("a bad payment deployment produces explainable degradation across the dependency path", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const events: SimulatorEvent[] = [];
  simulator.subscribe((event) => events.push(event));

  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const system = simulator.snapshot();
  const payment = system.services.find((service) => service.id === "payment-service");
  const checkout = system.services.find((service) => service.id === "checkout-service");
  const redis = system.services.find((service) => service.id === "redis");

  assert.equal(system.scenario, "bad-payment-deployment");
  assert.equal(payment?.version, "v1.8.3");
  assert.equal(payment?.health, "critical");
  assert.equal(checkout?.health, "degraded");
  assert.equal(redis?.health, "degraded");
  assert.ok((payment?.metrics.latencyMs ?? 0) > 1_000);
  assert.ok((checkout?.metrics.errorRate ?? 0) > 10);
  const deployment = events.find((event) => event.type === "deployment");
  assert.equal(deployment?.type, "deployment");
  if (deployment?.type === "deployment") {
    assert.equal(deployment.version, "v1.8.3");
    assert.equal(deployment.previousVersion, "v1.8.2");
    assert.equal(deployment.deploymentKind, "RELEASE");
  }
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "payment-service" && event.message.includes("connection pool")));
});

test("a Redis degradation raises Redis and dependent-service latency with timeout evidence", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const events: SimulatorEvent[] = [];
  simulator.subscribe((event) => events.push(event));

  simulator.triggerRedisDegradation();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const system = simulator.snapshot();
  const redis = system.services.find((service) => service.id === "redis");
  const payment = system.services.find((service) => service.id === "payment-service");
  const checkout = system.services.find((service) => service.id === "checkout-service");
  const auth = system.services.find((service) => service.id === "auth-service");

  assert.equal(system.scenario, "redis-degradation");
  assert.equal(redis?.health, "critical");
  assert.ok((redis?.metrics.latencyMs ?? 0) > 1_000);
  assert.ok((payment?.metrics.latencyMs ?? 0) > 1_000);
  assert.equal(auth?.health, "degraded");
  assert.ok((checkout?.metrics.errorRate ?? 0) > 10);
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "redis" && /latency/.test(event.message)));
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "payment-service" && /timeout/.test(event.message)));
});

test("a Kafka backlog exposes queue lag and delayed notification processing evidence", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const events: SimulatorEvent[] = [];
  simulator.subscribe((event) => events.push(event));

  simulator.triggerKafkaBacklog();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const system = simulator.snapshot();
  const kafka = system.services.find((service) => service.id === "kafka");
  const notifications = system.services.find((service) => service.id === "notification-service");

  assert.equal(system.scenario, "kafka-backlog");
  assert.ok((kafka?.metrics.queueLag ?? 0) > 10_000);
  assert.ok((kafka?.metrics.latencyMs ?? 0) > 1_000);
  assert.equal(notifications?.health, "degraded");
  assert.ok((notifications?.metrics.errorRate ?? 0) > 10);
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "kafka" && /consumer lag/.test(event.message)));
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "notification-service" && /delayed/.test(event.message)));
});

test("a service outage targets any component and propagates availability failures to its dependents", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const events: SimulatorEvent[] = [];
  simulator.subscribe((event) => events.push(event));

  simulator.triggerServiceOutage("inventory-service");
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const system = simulator.snapshot();
  const inventory = system.services.find((service) => service.id === "inventory-service");
  const checkout = system.services.find((service) => service.id === "checkout-service");
  const gateway = system.services.find((service) => service.id === "api-gateway");

  assert.equal(system.scenario, "service-outage");
  assert.equal(inventory?.health, "critical");
  assert.ok((inventory?.metrics.errorRate ?? 0) > 90);
  assert.equal(checkout?.health, "critical");
  assert.ok((checkout?.metrics.errorRate ?? 0) > 10);
  assert.equal(gateway?.health, "degraded");
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "inventory-service" && /unavailable/.test(event.message)));
});

test("recovering the system restores healthy versions and service health", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  simulator.recover();
  simulator.advance();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const system = simulator.snapshot();
  const payment = system.services.find((service) => service.id === "payment-service");
  const checkout = system.services.find((service) => service.id === "checkout-service");

  assert.equal(system.scenario, "healthy");
  assert.equal(payment?.version, "v1.8.2");
  assert.equal(payment?.health, "healthy");
  assert.equal(checkout?.health, "healthy");
});

test("a rollback command validates its target and starts recovery only for the matching defective deployment", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const rejected = simulator.rollbackDeployment({ serviceId: "checkout-service", fromVersion: "v4.2.0", toVersion: "v4.1.9" });
  assert.equal(rejected.ok, false);
  assert.equal(simulator.snapshot().scenario, "bad-payment-deployment");

  const accepted = simulator.rollbackDeployment({ serviceId: "payment-service", fromVersion: "v1.8.3", toVersion: "v1.8.2" });
  assert.equal(accepted.ok, true);
  assert.equal(simulator.snapshot().scenario, "recovering");
  assert.equal(simulator.snapshot().services.find((service) => service.id === "payment-service")?.version, "v1.8.2");
});

test("simulator retains bounded metric history for incident investigation", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  simulator.triggerBadPaymentDeployment();
  simulator.advance();
  simulator.advance();
  simulator.advance();

  const history = simulator.history("payment-service");

  assert.equal(history.serviceId, "payment-service");
  assert.equal(history.samples.length, 4);
  assert.ok(history.samples.at(-1)?.latencyMs > 1_000);
  assert.ok(history.samples.every((sample) => sample.timestamp === "2026-08-13T12:00:00.000Z"));
});
