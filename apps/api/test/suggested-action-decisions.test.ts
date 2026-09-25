import assert from "node:assert/strict";
import test from "node:test";

import { IncidentManager, IncidentOperationError } from "../src/incident-manager.ts";
import { TelemetrySimulator } from "../src/simulator.ts";
import { SuggestedActionDecisions } from "../src/incidents/suggested-action-decisions.ts";
import type { MitigationExecutor, MitigationResult, RollbackRequest } from "../src/incidents/ports.ts";

const maya = { id: "maya-chen", name: "Maya Chen" };
const daniel = { id: "daniel-okafor", name: "Daniel Okafor" };
const clock = { now: () => "2026-08-13T12:05:00.000Z" };

function incidentWithProposedRollback(): { readonly manager: IncidentManager; readonly actionId: string } {
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
  const actionId = manager.find("INC-1042")?.actions[0]?.id;
  assert.ok(actionId, "Expected a proposed action");
  return { manager, actionId };
}

function recordingExecutor(respond: (request: RollbackRequest) => MitigationResult = () => ({ ok: true, message: "rollback started" })): MitigationExecutor & { readonly requests: RollbackRequest[] } {
  const requests: RollbackRequest[] = [];
  return {
    requests,
    rollbackDeployment(request) {
      requests.push(request);
      return respond(request);
    },
  };
}

function operationErrorKind(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof IncidentOperationError, `Expected an IncidentOperationError, received ${String(error)}`);
    return error.kind;
  }
  assert.fail("Expected the operation to fail");
}

test("the incident commander's approval executes exactly the proposed rollback and records each step", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const executor = recordingExecutor();
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: executor, clock });
  manager.takeCommand("INC-1042", clock.now(), maya);

  const incident = decisions.approve("INC-1042", actionId, maya);

  assert.deepEqual(executor.requests, [{ serviceId: "payment-service", fromVersion: "v1.8.3", toVersion: "v1.8.2" }]);
  assert.equal(incident.actions[0]?.status, "COMPLETED");
  assert.equal(incident.actions[0]?.actor, "Maya Chen");
  const steps = incident.timeline.map((event) => event.type).filter((type) => type.startsWith("ACTION_") && type !== "ACTION_SUGGESTED");
  assert.deepEqual(steps, ["ACTION_APPROVED", "ACTION_EXECUTED", "ACTION_COMPLETED"]);
});

test("an approval without incident command is forbidden and never reaches the executor", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const executor = recordingExecutor();
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: executor, clock });

  assert.equal(operationErrorKind(() => decisions.approve("INC-1042", actionId, maya)), "forbidden");
  manager.takeCommand("INC-1042", clock.now(), maya);
  assert.equal(operationErrorKind(() => decisions.approve("INC-1042", actionId, daniel)), "forbidden");

  assert.equal(executor.requests.length, 0);
  assert.equal(manager.find("INC-1042")?.actions[0]?.status, "PROPOSED");
});

test("a rejected action records the reason and can no longer be approved or executed", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const executor = recordingExecutor();
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: executor, clock });
  manager.takeCommand("INC-1042", clock.now(), maya);

  const rejected = decisions.reject("INC-1042", actionId, maya, "Rollback window closed");
  assert.equal(rejected.actions[0]?.status, "REJECTED");
  assert.equal(rejected.actions[0]?.decisionReason, "Rollback window closed");

  assert.equal(operationErrorKind(() => decisions.approve("INC-1042", actionId, maya)), "conflict");
  assert.equal(executor.requests.length, 0);
});

test("a rollback the executor refuses is recorded as a failed action", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const executor = recordingExecutor(() => ({ ok: false, message: "No active defective deployment" }));
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: executor, clock });
  manager.takeCommand("INC-1042", clock.now(), maya);

  const incident = decisions.approve("INC-1042", actionId, maya);

  assert.equal(incident.actions[0]?.status, "FAILED");
  assert.equal(incident.actions[0]?.outcome, "No active defective deployment");
});

test("an executor error is recorded as a failed action instead of leaving the rollback executing", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const executor = recordingExecutor(() => {
    throw new Error("deployment system unreachable");
  });
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: executor, clock });
  manager.takeCommand("INC-1042", clock.now(), maya);

  const incident = decisions.approve("INC-1042", actionId, maya);

  assert.equal(incident.actions[0]?.status, "FAILED");
  assert.match(incident.actions[0]?.outcome ?? "", /deployment system unreachable/);
  assert.ok(incident.timeline.some((event) => event.type === "ACTION_FAILED"));
});

test("decisions on an unknown incident or action report not found", () => {
  const { manager, actionId } = incidentWithProposedRollback();
  const decisions = new SuggestedActionDecisions({ incidents: manager, mitigations: recordingExecutor(), clock });

  assert.equal(operationErrorKind(() => decisions.approve("INC-404", actionId, maya)), "not-found");
  assert.equal(operationErrorKind(() => decisions.reject("INC-1042", "ACT-404", maya, "Not needed")), "not-found");
});
