import type { IncidentManager } from "../incident-manager.ts";
import type { DemoSessionStore } from "../demo-session-store.ts";
import type { IncidentInvestigation } from "../incidents/incident-investigation.ts";
import type { Clock } from "../incidents/ports.ts";
import { isRecord, json, log, readJson, RequestBodyError, requireDemoUser, sendError, type Route } from "./http-kit.ts";
import { sendOperationError } from "./operation-errors.ts";

type IncidentRouteDependencies = {
  readonly incidentManager: IncidentManager;
  readonly investigation: IncidentInvestigation;
  readonly sessions: DemoSessionStore;
  readonly clock: Clock;
};

export function incidentRoutes({ incidentManager, investigation, sessions, clock }: IncidentRouteDependencies): readonly Route[] {
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
          try {
            const analysis = await investigation.investigate(incidentId, {
              onProviderFallback: () => log("investigation_provider_fallback", { requestId: context.requestId, reason: "provider_unavailable" }),
            });
            json(context.response, 200, analysis);
          } catch (error) {
            sendOperationError(context, error, "Unable to investigate incident");
          }
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
            json(context.response, 200, incidentManager.resolve(incidentId, clock.now(), actor));
          } catch (error) {
            sendOperationError(context, error, "Unable to resolve incident");
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
            json(context.response, 200, incidentManager.takeCommand(incidentId, clock.now(), actor, takeoverReason));
          } catch (error) {
            sendOperationError(context, error, "Unable to take incident command");
          }
        },
      },
    },
  ];
}

function isIncidentStatus(value: string | null): value is "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED" | null {
  return value === null || value === "DETECTED" || value === "INVESTIGATING" || value === "MONITORING" || value === "RESOLVED";
}

function isIncidentSeverity(value: string | null): value is "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4" | null {
  return value === null || value === "SEV-1" || value === "SEV-2" || value === "SEV-3" || value === "SEV-4";
}

function commandTakeoverReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string") throw new RequestBodyError("A takeover reason must be text");
  return value.reason;
}
