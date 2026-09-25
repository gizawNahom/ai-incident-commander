import { isServiceId, type TelemetrySimulator } from "../simulator.ts";
import type { IncidentManager } from "../incident-manager.ts";
import { json, sendError, type Route } from "./http-kit.ts";

export function serviceRoutes(simulator: TelemetrySimulator, incidentManager: IncidentManager): readonly Route[] {
  return [
    {
      pattern: /^\/api\/services$/,
      handle: {
        GET: ({ response }) => {
          json(response, 200, {
            services: simulator.snapshot().services.map((service) => ({
              ...service,
              activeAlertCount: incidentManager.activeAlertsFor(service.id).length,
              relatedIncidentCount: relatedIncidentsForService(incidentManager, service.id).length,
            })),
          });
        },
      },
    },
    {
      pattern: /^\/api\/services\/([^/]+)$/,
      handle: {
        GET: (context, [serviceId = ""]) => {
          if (!isServiceId(serviceId)) {
            sendError(context, 404, "Service not found");
            return;
          }
          const system = simulator.snapshot();
          const service = system.services.find((candidate) => candidate.id === serviceId);
          if (!service) {
            sendError(context, 404, "Service not found");
            return;
          }
          const byId = new Map(system.services.map((candidate) => [candidate.id, candidate]));
          json(context.response, 200, {
            service,
            history: simulator.history(serviceId),
            logs: simulator.recentLogs(serviceId),
            deployments: simulator.recentDeployments(serviceId),
            dependencies: service.dependencies.map((dependencyId) => byId.get(dependencyId)).filter((dependency): dependency is NonNullable<typeof dependency> => dependency !== undefined),
            dependents: system.services.filter((candidate) => candidate.dependencies.includes(serviceId)),
            activeAlerts: incidentManager.activeAlertsFor(serviceId),
            relatedIncidents: relatedIncidentsForService(incidentManager, serviceId),
          });
        },
      },
    },
  ];
}

function relatedIncidentsForService(incidentManager: IncidentManager, serviceId: string) {
  return incidentManager.list().filter((incident) =>
    incident.affectedServices.includes(serviceId) || incidentManager.evidenceFor(incident.id)?.contextServiceIds.includes(serviceId),
  );
}
