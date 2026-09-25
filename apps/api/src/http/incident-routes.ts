import type { TelemetrySimulator } from "../simulator.ts";
import { IncidentResolutionError, type IncidentManager, type SuggestedActionRecommendation } from "../incident-manager.ts";
import type { DemoSessionStore } from "../demo-session-store.ts";
import type { DeterministicInvestigator, IncidentInvestigator, Investigation } from "../../../../packages/ai/src/deterministic-investigator.ts";
import { isRecord, json, log, readJson, requireDemoUser, sendError, type Route } from "./http-kit.ts";

type IncidentRouteDependencies = {
  readonly simulator: TelemetrySimulator;
  readonly incidentManager: IncidentManager;
  readonly sessions: DemoSessionStore;
  readonly investigator: IncidentInvestigator;
  readonly deterministicInvestigator: DeterministicInvestigator;
};

export function incidentRoutes({ simulator, incidentManager, sessions, investigator, deterministicInvestigator }: IncidentRouteDependencies): readonly Route[] {
  return [
    {
      pattern: /^\/api\/incidents$/,
      handle: (context) => {
        const status = context.url.searchParams.get("status");
        const severity = context.url.searchParams.get("severity");
        if (!isIncidentStatus(status) || !isIncidentSeverity(severity)) {
          sendError(context, 400, "status and severity filters must be valid incident values");
          return;
        }
        const incidents = incidentManager.list().filter((incident) =>
          (status === null || incident.status === status) && (severity === null || incident.severity === severity),
        );
        json(context.response, 200, { incidents });
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)$/,
      handle: (context, [incidentId = ""]) => {
        const incident = incidentManager.find(incidentId);
        if (!incident) {
          sendError(context, 404, "Incident not found");
          return;
        }
        json(context.response, 200, incident);
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/evidence$/,
      handle: (context, [incidentId = ""]) => {
        const evidence = incidentManager.evidenceFor(incidentId);
        if (!evidence) {
          sendError(context, 404, "Incident evidence not found");
          return;
        }
        json(context.response, 200, evidence);
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/investigate$/,
      handle: {
        POST: async (context, [incidentId = ""]) => {
          const incident = incidentManager.find(incidentId);
          if (!incident) {
            sendError(context, 404, "Incident not found");
            return;
          }
          const evidence = incidentManager.evidenceFor(incidentId);
          if (!evidence) {
            sendError(context, 409, "Incident evidence is not available");
            return;
          }
          const investigationContext = {
            incident: { ...incident, timeline: incident.timeline.filter(isInvestigationTimelineEvent) },
            services: evidence.topology,
            metricHistories: evidence.metricHistories,
          };
          let analysis: Investigation;
          try {
            analysis = await investigator.investigate(investigationContext);
          } catch {
            log("investigation_provider_fallback", { requestId: context.requestId, reason: "provider_unavailable" });
            analysis = { ...deterministicInvestigator.investigate(investigationContext), fallbackReason: "AI provider unavailable; offline evidence analysis shown." };
          }
          incidentManager.recordInvestigation({
            incidentId,
            timestamp: simulator.snapshot().timestamp,
            hypothesis: analysis.hypotheses[0]?.inference ?? "No hypothesis could be generated from the available evidence.",
            suggestedAction: recommendationFrom(analysis),
          });
          json(context.response, 200, analysis);
        },
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/resolve$/,
      handle: {
        POST: (context, [incidentId = ""]) => {
          const actor = requireDemoUser(context, sessions);
          if (!actor) return;
          try {
            json(context.response, 200, incidentManager.resolve(incidentId, simulator.snapshot().timestamp, actor));
          } catch (error) {
            const status = error instanceof IncidentResolutionError && error.message === "Incident not found" ? 404 : error instanceof IncidentResolutionError && /Incident Commander/.test(error.message) ? 403 : 409;
            sendError(context, status, error instanceof Error ? error.message : "Unable to resolve incident");
          }
        },
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/command$/,
      handle: {
        POST: async (context, [incidentId = ""]) => {
          const actor = requireDemoUser(context, sessions);
          if (!actor) return;
          try {
            const takeoverReason = context.request.headers["content-type"]?.includes("application/json") ? commandTakeoverReason(await readJson(context.request)) : undefined;
            json(context.response, 200, incidentManager.takeCommand(incidentId, simulator.snapshot().timestamp, actor, takeoverReason));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to take incident command";
            sendError(context, message === "Incident not found" ? 404 : 409, message);
          }
        },
      },
    },
  ];
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

function isIncidentStatus(value: string | null): value is "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED" | null {
  return value === null || value === "DETECTED" || value === "INVESTIGATING" || value === "MONITORING" || value === "RESOLVED";
}

function isIncidentSeverity(value: string | null): value is "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4" | null {
  return value === null || value === "SEV-1" || value === "SEV-2" || value === "SEV-3" || value === "SEV-4";
}

function isInvestigationTimelineEvent(event: { readonly type: string }): event is { readonly type: "DEPLOYMENT" | "LOG" | "ALERT_TRIGGERED" | "INCIDENT_CREATED"; readonly timestamp: string; readonly message: string; readonly serviceId?: string; readonly version?: string; readonly previousVersion?: string; readonly deploymentKind?: "RELEASE" | "ROLLBACK" } {
  return event.type === "DEPLOYMENT" || event.type === "LOG" || event.type === "ALERT_TRIGGERED" || event.type === "INCIDENT_CREATED";
}

function commandTakeoverReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string") throw new Error("A takeover reason must be text");
  return value.reason;
}
