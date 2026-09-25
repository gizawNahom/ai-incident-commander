import type { IncidentInvestigator, Investigation, InvestigationContext, InvestigationTimelineEvent } from "../../../../packages/ai/src/deterministic-investigator.ts";
import { IncidentOperationError, type IncidentManager, type SuggestedActionRecommendation } from "../incident-manager.ts";
import type { Clock } from "./ports.ts";

type InvestigatedIncidents = Pick<IncidentManager, "find" | "evidenceFor" | "recordInvestigation">;

type IncidentInvestigationDependencies = {
  readonly incidents: InvestigatedIncidents;
  readonly investigator: IncidentInvestigator;
  // Offline analysis used when the configured investigator cannot answer (ADR-0006, ADR-0007).
  readonly fallbackInvestigator: IncidentInvestigator;
  readonly clock: Clock;
};

type InvestigationOptions = {
  readonly onProviderFallback?: () => void;
};

// Analyses an incident from its preserved evidence, never from live telemetry,
// and records the hypothesis and any proposed mitigation in the audit timeline.
export class IncidentInvestigation {
  private readonly incidents: InvestigatedIncidents;
  private readonly investigator: IncidentInvestigator;
  private readonly fallbackInvestigator: IncidentInvestigator;
  private readonly clock: Clock;

  constructor({ incidents, investigator, fallbackInvestigator, clock }: IncidentInvestigationDependencies) {
    this.incidents = incidents;
    this.investigator = investigator;
    this.fallbackInvestigator = fallbackInvestigator;
    this.clock = clock;
  }

  async investigate(incidentId: string, options: InvestigationOptions = {}): Promise<Investigation> {
    const incident = this.incidents.find(incidentId);
    if (!incident) throw new IncidentOperationError("not-found", "Incident not found");
    const evidence = this.incidents.evidenceFor(incidentId);
    if (!evidence) throw new IncidentOperationError("conflict", "Incident evidence is not available");
    const context: InvestigationContext = {
      incident: { ...incident, timeline: incident.timeline.filter(isInvestigationTimelineEvent) },
      services: evidence.topology,
      metricHistories: evidence.metricHistories,
    };
    let analysis: Investigation;
    try {
      analysis = await this.investigator.investigate(context);
    } catch {
      options.onProviderFallback?.();
      analysis = { ...(await this.fallbackInvestigator.investigate(context)), fallbackReason: "AI provider unavailable; offline evidence analysis shown." };
    }
    this.incidents.recordInvestigation({
      incidentId,
      timestamp: this.clock.now(),
      hypothesis: analysis.hypotheses[0]?.inference ?? "No hypothesis could be generated from the available evidence.",
      suggestedAction: recommendationFrom(analysis),
    });
    return analysis;
  }
}

function isInvestigationTimelineEvent(event: { readonly type: string }): event is InvestigationTimelineEvent {
  return event.type === "DEPLOYMENT" || event.type === "LOG" || event.type === "ALERT_TRIGGERED" || event.type === "INCIDENT_CREATED";
}

// The recorded action keeps the investigator's rationale and cites the evidence behind the leading hypothesis.
function recommendationFrom(analysis: Investigation): SuggestedActionRecommendation | undefined {
  const proposal = analysis.suggestedAction;
  if (!proposal) return undefined;
  return {
    type: proposal.type,
    targetServiceId: proposal.targetServiceId,
    fromVersion: proposal.fromVersion,
    toVersion: proposal.toVersion,
    reasoning: proposal.rationale,
    evidenceIds: analysis.hypotheses[0]?.evidenceIds ?? [],
    risk: proposal.risk,
  };
}
