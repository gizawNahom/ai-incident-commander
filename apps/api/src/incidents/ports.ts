// Driven ports for incident use cases. The composition root adapts the
// simulator to both; a real deployment system could replace the executor.

// Simulated time, so every audit entry shares the simulator's clock.
export type Clock = {
  readonly now: () => string;
};

export type RollbackRequest = {
  readonly serviceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
};

export type MitigationResult = {
  readonly ok: boolean;
  readonly message: string;
};

// Carries out an operational action. Only SuggestedActionDecisions calls it,
// and only after an Incident Commander's approval has been recorded (ADR-0004).
export type MitigationExecutor = {
  readonly rollbackDeployment: (request: RollbackRequest) => MitigationResult;
};
