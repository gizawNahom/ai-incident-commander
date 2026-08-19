import assert from "node:assert/strict";
import test from "node:test";

import { scenarioControl, serviceOutageRequest } from "../public/scenario-controls.js";

test("maps each named chaos scenario to its simulator endpoint", () => {
  assert.deepEqual(scenarioControl("bad-payment-deployment"), {
    method: "POST",
    path: "/api/simulator/bad-payment-deployment",
  });
  assert.deepEqual(scenarioControl("redis-degradation"), {
    method: "POST",
    path: "/api/simulator/redis-degradation",
  });
  assert.deepEqual(scenarioControl("kafka-backlog"), {
    method: "POST",
    path: "/api/simulator/kafka-backlog",
  });
});

test("creates a validated-target request shape for a service outage", () => {
  assert.deepEqual(serviceOutageRequest("inventory-service"), {
    method: "POST",
    path: "/api/simulator/service-outage",
    body: { serviceId: "inventory-service" },
  });
});
