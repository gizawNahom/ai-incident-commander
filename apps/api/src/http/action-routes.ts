import type { DemoSessionStore } from "../demo-session-store.ts";
import type { SuggestedActionDecisions } from "../incidents/suggested-action-decisions.ts";
import { isRecord, json, readJson, RequestBodyError, requireDemoUser, sendError, type Route } from "./http-kit.ts";
import { sendOperationError } from "./operation-errors.ts";

export function actionRoutes(decisions: SuggestedActionDecisions, sessions: DemoSessionStore): readonly Route[] {
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
          try {
            json(context.response, 200, decisions.approve(incidentId, actionId, actor));
          } catch (error) {
            sendOperationError(context, error, "Unable to update suggested action");
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
            json(context.response, 200, decisions.reject(incidentId, actionId, actor, reason));
          } catch (error) {
            sendOperationError(context, error, "Unable to update suggested action");
          }
        },
      },
    },
  ];
}

function actionRejectionReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string" || value.reason.trim().length === 0) throw new RequestBodyError("A non-empty rejection reason is required");
  return value.reason.trim();
}
