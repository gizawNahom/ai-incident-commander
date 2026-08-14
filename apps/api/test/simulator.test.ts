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
  assert.ok(events.some((event) => event.type === "deployment" && event.version === "v1.8.3"));
  assert.ok(events.some((event) => event.type === "log" && event.serviceId === "payment-service" && event.message.includes("connection pool")));
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
