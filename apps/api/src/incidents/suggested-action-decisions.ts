import type { IncidentActor } from "../../../../packages/domain/src/incident-command.ts";
import { IncidentActionError, type DetectedIncident, type IncidentManager } from "../incident-manager.ts";
import type { Clock, MitigationExecutor, MitigationResult } from "./ports.ts";

type ActionIncidents = Pick<IncidentManager, "find" | "approveAction" | "rejectAction" | "beginActionExecution" | "completeAction" | "failAction">;

type SuggestedActionDecisionDependencies = {
  readonly incidents: ActionIncidents;
  readonly mitigations: MitigationExecutor;
  readonly clock: Clock;
};

// The only path from a proposed action to an operational change: the approval
// is recorded first, then execution starts, then its outcome is recorded.
export class SuggestedActionDecisions {
  private readonly incidents: ActionIncidents;
  private readonly mitigations: MitigationExecutor;
  private readonly clock: Clock;

  constructor({ incidents, mitigations, clock }: SuggestedActionDecisionDependencies) {
    this.incidents = incidents;
    this.mitigations = mitigations;
    this.clock = clock;
  }

  approve(incidentId: string, actionId: string, actor: IncidentActor): DetectedIncident {
    const timestamp = this.clock.now();
    const approved = this.incidents.approveAction(incidentId, actionId, timestamp, actor);
    const executing = this.incidents.beginActionExecution(incidentId, approved.id, timestamp);
    let result: MitigationResult;
    try {
      result = this.mitigations.rollbackDeployment({
        serviceId: executing.targetServiceId,
        fromVersion: executing.fromVersion,
        toVersion: executing.toVersion,
      });
    } catch (error) {
      result = { ok: false, message: `Rollback could not be executed: ${error instanceof Error ? error.message : "unknown executor error"}` };
    }
    if (result.ok) {
      this.incidents.completeAction(incidentId, executing.id, timestamp, result.message);
    } else {
      this.incidents.failAction(incidentId, executing.id, timestamp, result.message);
    }
    return this.current(incidentId);
  }

  reject(incidentId: string, actionId: string, actor: IncidentActor, reason: string): DetectedIncident {
    this.incidents.rejectAction(incidentId, actionId, this.clock.now(), actor, reason);
    return this.current(incidentId);
  }

  private current(incidentId: string): DetectedIncident {
    const incident = this.incidents.find(incidentId);
    if (!incident) throw new IncidentActionError("not-found", "Incident not found");
    return incident;
  }
}
