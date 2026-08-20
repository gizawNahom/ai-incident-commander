import assert from "node:assert/strict";
import test from "node:test";

import { DeterministicInvestigator } from "../src/deterministic-investigator.ts";

test("grounds a deployment hypothesis in generic incident evidence rather than service-name rules", () => {
  const investigator = new DeterministicInvestigator();

  const analysis = investigator.investigate({
    incident: {
      id: "INC-77",
      title: "Storefront degradation",
      startedAt: "2026-08-14T12:00:20.000Z",
      affectedServices: ["orders-worker", "storefront"],
      alerts: [
        { id: "ALR-1", serviceId: "orders-worker", title: "Orders Worker latency above 1,000 ms", threshold: 1_000, observedValue: 1_430, unit: "ms", triggeredAt: "2026-08-14T12:00:10.000Z" },
        { id: "ALR-2", serviceId: "storefront", title: "Storefront error rate above 10%", threshold: 10, observedValue: 18, unit: "%", triggeredAt: "2026-08-14T12:00:20.000Z" },
      ],
      timeline: [
        { type: "DEPLOYMENT", timestamp: "2026-08-14T12:00:00.000Z", serviceId: "orders-worker", version: "v9.0.0", previousVersion: "v8.9.3", message: "orders-worker v9.0.0 deployment completed" },
        { type: "LOG", timestamp: "2026-08-14T12:00:12.000Z", serviceId: "orders-worker", message: "connection pool timeout while processing order" },
      ],
    },
    services: [
      { id: "storefront", name: "Storefront", dependencies: ["orders-worker"] },
      { id: "orders-worker", name: "Orders Worker", dependencies: ["queue-store"] },
      { id: "queue-store", name: "Queue Store", dependencies: [] },
    ],
    metricHistories: [
      { serviceId: "orders-worker", samples: [{ timestamp: "2026-08-14T11:59:00.000Z", latencyMs: 120, errorRate: 0.2 }, { timestamp: "2026-08-14T12:00:20.000Z", latencyMs: 1_430, errorRate: 4.2 }] },
      { serviceId: "storefront", samples: [{ timestamp: "2026-08-14T11:59:00.000Z", latencyMs: 100, errorRate: 0.3 }, { timestamp: "2026-08-14T12:00:20.000Z", latencyMs: 240, errorRate: 18 }] },
    ],
  });

  assert.match(analysis.summary, /Storefront degradation/);
  assert.equal(analysis.hypotheses[0].targetServiceId, "orders-worker");
  assert.match(analysis.hypotheses[0].inference, /orders-worker v9\.0\.0 deployment/i);
  assert.ok(analysis.knownEvidence.some((evidence) => evidence.serviceId === "orders-worker" && evidence.kind === "deployment"));
  assert.ok(analysis.knownEvidence.some((evidence) => evidence.kind === "metric-change" && /120 ms to 1,430 ms/.test(evidence.detail)));
  assert.ok(analysis.knownEvidence.some((evidence) => evidence.kind === "log" && /connection pool timeout/i.test(evidence.detail)));
  assert.ok(analysis.hypotheses[0].evidenceIds.includes("evidence-orders-worker-latency"));
  assert.match(analysis.uncertainty, /correlation.*not prove/i);
  assert.deepEqual(analysis.suggestedAction, {
    type: "ROLLBACK_DEPLOYMENT",
    targetServiceId: "orders-worker",
    fromVersion: "v9.0.0",
    toVersion: "v8.9.3",
    status: "PROPOSED",
    risk: "medium",
    rationale: "The deployment immediately preceded the observed degradation.",
  });
  assert.doesNotMatch(JSON.stringify(analysis), /payment-service|checkout-service/i);
});

test("does not fabricate a deployment rollback when incident evidence contains no deployment", () => {
  const investigator = new DeterministicInvestigator();

  const analysis = investigator.investigate({
    incident: {
      id: "INC-78",
      title: "Search latency degradation",
      startedAt: "2026-08-14T12:00:20.000Z",
      affectedServices: ["search-api", "search-index"],
      alerts: [
        { id: "ALR-3", serviceId: "search-api", title: "Search API latency above 1,000 ms", threshold: 1_000, observedValue: 1_800, unit: "ms", triggeredAt: "2026-08-14T12:00:20.000Z" },
        { id: "ALR-4", serviceId: "search-index", title: "Search Index error rate above 10%", threshold: 10, observedValue: 14, unit: "%", triggeredAt: "2026-08-14T12:00:20.000Z" },
      ],
      timeline: [],
    },
    services: [
      { id: "search-api", name: "Search API", dependencies: ["search-index"] },
      { id: "search-index", name: "Search Index", dependencies: [] },
    ],
    metricHistories: [],
  });

  assert.equal(analysis.suggestedAction, undefined);
  assert.match(analysis.uncertainty, /No relevant deployment/i);
});
