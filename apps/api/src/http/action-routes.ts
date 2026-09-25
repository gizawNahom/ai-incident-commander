import type { ServerResponse } from "node:http";

import type { ServiceId, TelemetrySimulator } from "../simulator.ts";
import { IncidentActionError, type IncidentManager } from "../incident-manager.ts";
import type { DemoSessionStore } from "../demo-session-store.ts";
import { isRecord, json, readJson, requireDemoUser, sendError, type RequestContext, type Route } from "./http-kit.ts";

export function actionRoutes(simulator: TelemetrySimulator, incidentManager: IncidentManager, sessions: DemoSessionStore): readonly Route[] {
  return [
    {
      pattern: /^\/api\/incidents\/([^/]+)\/actions\/[^/]+\/execute$/,
      handle: {
        POST: (context) => sendError(context, 409, "Suggested actions execute only through explicit approval"),
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/actions\/([^/]+)\/approve$/,
      handle: {
        POST: (context, [incidentId = "", actionId = ""]) => {
          const actor = requireDemoUser(context, sessions);
          if (!actor) return;
          const timestamp = simulator.snapshot().timestamp;
          try {
            const approved = incidentManager.approveAction(incidentId, actionId, timestamp, actor);
            const executing = incidentManager.beginActionExecution(incidentId, approved.id, timestamp);
            const result = simulator.rollbackDeployment({
              serviceId: executing.targetServiceId as ServiceId,
              fromVersion: executing.fromVersion,
              toVersion: executing.toVersion,
            });
            if (result.ok) {
              incidentManager.completeAction(incidentId, executing.id, timestamp, result.message);
            } else {
              incidentManager.failAction(incidentId, executing.id, timestamp, result.message);
            }
            respondWithIncident(incidentManager, incidentId, context.response);
          } catch (error) {
            sendActionError(context, error);
          }
        },
      },
    },
    {
      pattern: /^\/api\/incidents\/([^/]+)\/actions\/([^/]+)\/reject$/,
      handle: {
        POST: async (context, [incidentId = "", actionId = ""]) => {
          const actor = requireDemoUser(context, sessions);
          if (!actor) return;
          try {
            const reason = actionRejectionReason(await readJson(context.request));
            incidentManager.rejectAction(incidentId, actionId, simulator.snapshot().timestamp, actor, reason);
            respondWithIncident(incidentManager, incidentId, context.response);
          } catch (error) {
            sendActionError(context, error);
          }
        },
      },
    },
  ];
}

function respondWithIncident(incidentManager: IncidentManager, incidentId: string, response: ServerResponse): void {
  const incident = incidentManager.find(incidentId);
  if (!incident) throw new IncidentActionError("Incident not found");
  json(response, 200, incident);
}

function sendActionError(context: RequestContext, error: unknown): void {
  const message = error instanceof IncidentActionError ? error.message : "Unable to update suggested action";
  const status = message.includes("not found") ? 404 : /Incident Commander|Incident Commander must be assigned/.test(message) ? 403 : 409;
  sendError(context, status, message);
}

function actionRejectionReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string" || value.reason.trim().length === 0) throw new IncidentActionError("A non-empty rejection reason is required");
  return value.reason.trim();
}
