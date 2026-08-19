import assert from "node:assert/strict";
import test from "node:test";

import { selectIncidentMetricCards } from "../public/incident-metrics.js";

test("uses the alerting services and their triggered metrics for a Kafka incident", () => {
  const cards = selectIncidentMetricCards({
    alerts: [
      { serviceId: "kafka", metric: "queueLag" },
      { serviceId: "notification-service", metric: "errorRate" },
    ],
    topology: [
      { id: "notification-service", name: "Notification Service", kind: "service", dependencies: ["kafka"] },
      { id: "kafka", name: "Kafka", kind: "stream", dependencies: [] },
    ],
    histories: [
      { serviceId: "kafka", samples: [{ queueLag: 0 }, { queueLag: 22_500 }] },
      { serviceId: "notification-service", samples: [{ errorRate: 0.2 }, { errorRate: 15.2 }] },
    ],
  });

  assert.deepEqual(cards, [
    { serviceId: "kafka", serviceName: "Kafka", metric: "queueLag" },
    { serviceId: "notification-service", serviceName: "Notification Service", metric: "errorRate" },
  ]);
});

test("adds a direct dependency as context after the primary alert metrics", () => {
  const cards = selectIncidentMetricCards({
    alerts: [
      { serviceId: "payment-service", metric: "latencyMs" },
      { serviceId: "checkout-service", metric: "errorRate" },
    ],
    topology: [
      { id: "payment-service", name: "Payment Service", kind: "service", dependencies: ["redis", "kafka"] },
      { id: "checkout-service", name: "Checkout Service", kind: "service", dependencies: ["payment-service"] },
      { id: "redis", name: "Redis", kind: "datastore", dependencies: [] },
      { id: "kafka", name: "Kafka", kind: "stream", dependencies: [] },
    ],
    histories: [
      { serviceId: "payment-service", samples: [{ latencyMs: 120 }, { latencyMs: 2_100 }] },
      { serviceId: "checkout-service", samples: [{ errorRate: 0.3 }, { errorRate: 19 }] },
      { serviceId: "redis", samples: [{ latencyMs: 5 }, { latencyMs: 110 }] },
    ],
  });

  assert.deepEqual(cards, [
    { serviceId: "payment-service", serviceName: "Payment Service", metric: "latencyMs" },
    { serviceId: "checkout-service", serviceName: "Checkout Service", metric: "errorRate" },
    { serviceId: "redis", serviceName: "Redis", metric: "latencyMs" },
  ]);
});
