import { AlertPolicyNotFoundError, AlertPolicyValidationError, type AlertPolicyStore } from "../alert-policy-store.ts";
import type { IncidentManager } from "../incident-manager.ts";
import { json, readJson, RequestBodyError, sendError, type Route } from "./http-kit.ts";

export function alertPolicyRoutes(alertPolicies: AlertPolicyStore, incidentManager: IncidentManager): readonly Route[] {
  return [
    {
      pattern: /^\/api\/alert-policies$/,
      handle: {
        GET: ({ response }) => json(response, 200, { policies: alertPolicies.list() }),
        POST: async (context) => {
          try {
            const policy = alertPolicies.create(await readJson(context.request));
            incidentManager.setPolicies(alertPolicies.list());
            json(context.response, 201, { policy });
          } catch (error) {
            sendError(context, 400, policyErrorMessage(error));
          }
        },
      },
    },
    {
      pattern: /^\/api\/alert-policies\/([^/]+)$/,
      handle: {
        PUT: async (context, [policyId = ""]) => {
          try {
            const policy = alertPolicies.update(policyId, await readJson(context.request));
            incidentManager.setPolicies(alertPolicies.list());
            json(context.response, 200, { policy });
          } catch (error) {
            if (error instanceof AlertPolicyNotFoundError) {
              sendError(context, 404, error.message);
              return;
            }
            sendError(context, 400, policyErrorMessage(error));
          }
        },
      },
    },
  ];
}

function policyErrorMessage(error: unknown): string {
  return error instanceof AlertPolicyValidationError || error instanceof RequestBodyError ? error.message : "Unable to update alert policy";
}
