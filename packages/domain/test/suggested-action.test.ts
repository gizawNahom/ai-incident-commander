import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionTransitionError,
  approveSuggestedAction,
  beginSuggestedActionExecution,
  completeSuggestedAction,
  proposeRollback,
} from "../src/suggested-action.ts";

test("a proposed rollback requires approval before it can execute", () => {
  const proposed = proposeRollback({
    id: "ACT-1",
    incidentId: "INC-1042",
    targetServiceId: "orders-service",
    fromVersion: "v9.0.0",
    toVersion: "v8.9.3",
    reasoning: "The release immediately preceded the observed degradation.",
    evidenceIds: ["evidence-deployment"],
    risk: "medium",
    proposedAt: "2026-08-13T12:00:00.000Z",
  });

  assert.equal(proposed.type, "ROLLBACK_DEPLOYMENT");
  assert.equal(proposed.status, "PROPOSED");
  assert.throws(() => beginSuggestedActionExecution(proposed, "2026-08-13T12:00:01.000Z"), ActionTransitionError);

  const approved = approveSuggestedAction(proposed, "2026-08-13T12:00:02.000Z", "Engineer (demo)");
  const executing = beginSuggestedActionExecution(approved, "2026-08-13T12:00:03.000Z");
  const completed = completeSuggestedAction(executing, "2026-08-13T12:00:04.000Z", "Rollback command accepted by the simulator.");

  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.actor, "Engineer (demo)");
  assert.equal(completed.outcome, "Rollback command accepted by the simulator.");
  assert.throws(() => approveSuggestedAction(completed, "2026-08-13T12:00:05.000Z", "Engineer (demo)"), ActionTransitionError);
});
