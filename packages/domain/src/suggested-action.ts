export type ActionStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTING" | "COMPLETED" | "FAILED";
export type ActionRisk = "low" | "medium" | "high";

export type SuggestedAction = {
  readonly id: string;
  readonly incidentId: string;
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly targetServiceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reasoning: string;
  readonly evidenceIds: readonly string[];
  readonly risk: ActionRisk;
  readonly status: ActionStatus;
  readonly proposedAt: string;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly executingAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly actor?: string;
  readonly decisionReason?: string;
  readonly outcome?: string;
};

export type ProposeRollbackInput = Omit<SuggestedAction, "type" | "status" | "approvedAt" | "rejectedAt" | "executingAt" | "completedAt" | "failedAt" | "actor" | "decisionReason" | "outcome">;

export class ActionTransitionError extends Error {}

export function proposeRollback(input: ProposeRollbackInput): SuggestedAction {
  return { ...input, type: "ROLLBACK_DEPLOYMENT", status: "PROPOSED" };
}

export function approveSuggestedAction(action: SuggestedAction, timestamp: string, actor: string): SuggestedAction {
  if (action.status !== "PROPOSED") throw new ActionTransitionError(`Only a proposed action can be approved; action is ${action.status}`);
  return { ...action, status: "APPROVED", approvedAt: timestamp, actor };
}

export function rejectSuggestedAction(action: SuggestedAction, timestamp: string, actor: string, reason: string): SuggestedAction {
  if (action.status !== "PROPOSED") throw new ActionTransitionError(`Only a proposed action can be rejected; action is ${action.status}`);
  if (reason.trim().length === 0) throw new ActionTransitionError("A rejection reason is required");
  return { ...action, status: "REJECTED", rejectedAt: timestamp, actor, decisionReason: reason };
}

export function beginSuggestedActionExecution(action: SuggestedAction, timestamp: string): SuggestedAction {
  if (action.status !== "APPROVED") throw new ActionTransitionError(`Only an approved action can execute; action is ${action.status}`);
  return { ...action, status: "EXECUTING", executingAt: timestamp };
}

export function completeSuggestedAction(action: SuggestedAction, timestamp: string, outcome: string): SuggestedAction {
  if (action.status !== "EXECUTING") throw new ActionTransitionError(`Only an executing action can complete; action is ${action.status}`);
  return { ...action, status: "COMPLETED", completedAt: timestamp, outcome };
}

export function failSuggestedAction(action: SuggestedAction, timestamp: string, outcome: string): SuggestedAction {
  if (action.status !== "EXECUTING") throw new ActionTransitionError(`Only an executing action can fail; action is ${action.status}`);
  return { ...action, status: "FAILED", failedAt: timestamp, outcome };
}
