import assert from "node:assert/strict";
import test from "node:test";

import { buildInvestigationView } from "../public/investigation-view.js";

test("creates a view model that keeps known evidence, inference, and uncertainty distinct", () => {
  const view = buildInvestigationView({
    source: "gemini",
    summary: "Storefront degradation has 2 correlated alerts affecting Storefront and Orders Worker.",
    knownEvidence: [
      { id: "deployment", kind: "deployment", serviceId: "orders-worker", detail: "orders-worker v9.0.0 deployment completed" },
      { id: "metric", kind: "metric-change", serviceId: "orders-worker", detail: "Latency increased from 120 ms to 1,430 ms." },
    ],
    hypotheses: [{ targetServiceId: "orders-worker", confidence: "high", inference: "The deployment is the likely initiating event.", evidenceIds: ["deployment", "metric"] }],
    uncertainty: "Correlation does not prove the deployment caused degradation.",
    suggestedAction: { type: "ROLLBACK_DEPLOYMENT", targetServiceId: "orders-worker", fromVersion: "v9.0.0", toVersion: "v8.9.3", status: "PROPOSED", risk: "medium", rationale: "The deployment immediately preceded the observed degradation." },
  }, [{
    id: "ACT-1",
    type: "ROLLBACK_DEPLOYMENT",
    targetServiceId: "orders-worker",
    fromVersion: "v9.0.0",
    toVersion: "v8.9.3",
    status: "PROPOSED",
    risk: "medium",
    reasoning: "The deployment immediately preceded the observed degradation.",
  }]);

  assert.equal(view.confidenceLabel, "High confidence");
  assert.equal(view.sourceLabel, "Gemini-assisted · citations validated");
  assert.deepEqual(view.evidence, [
    "orders-worker v9.0.0 deployment completed",
    "Latency increased from 120 ms to 1,430 ms.",
  ]);
  assert.equal(view.action.label, "Rollback orders-worker");
  assert.equal(view.action.versionChange, "v9.0.0 → v8.9.3");
  assert.equal(view.action.status, "Proposed — approval required");
  assert.equal(view.action.id, "ACT-1");
  assert.equal(view.action.canDecide, true);
  assert.match(view.uncertainty, /does not prove/i);
});
