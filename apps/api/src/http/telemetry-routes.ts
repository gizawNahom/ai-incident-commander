import { isServiceId, type TelemetrySimulator } from "../simulator.ts";
import type { IncidentManager } from "../incident-manager.ts";
import { json, sendError, type Route } from "./http-kit.ts";

export function telemetryRoutes(simulator: TelemetrySimulator, incidentManager: IncidentManager): readonly Route[] {
  return [
    {
      pattern: /^\/api\/health$/,
      handle: ({ response }) => json(response, 200, { status: "ok", service: "ai-incident-commander-api" }),
    },
    {
      pattern: /^\/api\/telemetry\/current$/,
      handle: ({ response }) => json(response, 200, simulator.current()),
    },
    {
      pattern: /^\/api\/telemetry\/history$/,
      handle: (context) => {
        const serviceId = context.url.searchParams.get("service");
        if (!isServiceId(serviceId)) {
          sendError(context, 400, "A valid service query parameter is required");
          return;
        }
        json(context.response, 200, simulator.history(serviceId));
      },
    },
    {
      pattern: /^\/api\/system$/,
      handle: ({ response }) => json(response, 200, simulator.snapshot()),
    },
    {
      pattern: /^\/api\/detection-status$/,
      handle: ({ response }) => json(response, 200, incidentManager.detectionStatus()),
    },
  ];
}
