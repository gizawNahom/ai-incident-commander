import { createServer as createHttpServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { serviceIds, TelemetrySimulator, type ServiceId, type SimulatorEvent, type TelemetrySample } from "./simulator.ts";
import { IncidentActionError, IncidentManager, IncidentResolutionError, type IncidentEvent } from "./incident-manager.ts";
import { AlertPolicyNotFoundError, AlertPolicyStore, AlertPolicyValidationError } from "./alert-policy-store.ts";
import { DeterministicInvestigator, type IncidentInvestigator, type Investigation } from "../../../packages/ai/src/deterministic-investigator.ts";
import { GeminiGenerateContentTransport, GeminiInvestigator } from "../../../packages/ai/src/gemini-investigator.ts";

type AppOptions = { readonly autoStart?: boolean; readonly tickIntervalMs?: number; readonly investigator?: IncidentInvestigator };
type RunningApp = {
  listen: () => Promise<string>;
  close: () => Promise<void>;
  advance: () => TelemetrySample;
  triggerBadPaymentDeployment: () => void;
  triggerRedisDegradation: () => void;
  triggerKafkaBacklog: () => void;
  triggerServiceOutage: (serviceId: ServiceId) => void;
  recover: () => void;
};

const webRoot = join(process.cwd(), "apps/web/public");

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function log(event: string, fields: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`);
}

export function createServer(options: AppOptions = {}): RunningApp {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date() });
  const alertPolicies = new AlertPolicyStore(serviceIds);
  const incidentManager = new IncidentManager({ policies: alertPolicies.list() });
  const deterministicInvestigator = new DeterministicInvestigator();
  const investigator = options.investigator ?? configuredInvestigator(deterministicInvestigator);
  const streams = new Set<ServerResponse>();
  const unsubscribe = simulator.subscribe((event: SimulatorEvent) => {
    broadcast(streams, event);
    incidentManager.observe(event);
  });
  const unsubscribeIncidents = incidentManager.subscribe((event: IncidentEvent) => broadcast(streams, event));
  incidentManager.observe({ type: "system", system: simulator.snapshot() });
  let interval: NodeJS.Timeout | undefined;

  const httpServer: Server = createHttpServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    const url = new URL(request.url ?? "/", "http://localhost");
    log("request_received", { requestId, method: request.method ?? "UNKNOWN", path: url.pathname });

    if (url.pathname === "/api/health") {
      json(response, 200, { status: "ok", service: "ai-incident-commander-api" });
      return;
    }
    if (url.pathname === "/api/telemetry/current") {
      json(response, 200, simulator.current());
      return;
    }
    if (url.pathname === "/api/telemetry/history") {
      const serviceId = url.searchParams.get("service");
      if (!isServiceId(serviceId)) {
        json(response, 400, { error: "A valid service query parameter is required", requestId });
        return;
      }
      json(response, 200, simulator.history(serviceId));
      return;
    }
    if (url.pathname === "/api/system") {
      json(response, 200, simulator.snapshot());
      return;
    }
    if (url.pathname === "/api/detection-status") {
      json(response, 200, incidentManager.detectionStatus());
      return;
    }
    if (url.pathname === "/api/services") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      json(response, 200, {
        services: simulator.snapshot().services.map((service) => ({
          ...service,
          activeAlertCount: incidentManager.activeAlertsFor(service.id).length,
          relatedIncidentCount: relatedIncidentsForService(incidentManager, service.id).length,
        })),
      });
      return;
    }
    if (url.pathname.startsWith("/api/services/")) {
      if (request.method !== "GET") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      const serviceId = decodeURIComponent(url.pathname.slice("/api/services/".length));
      if (!isServiceId(serviceId)) {
        json(response, 404, { error: "Service not found", requestId });
        return;
      }
      const system = simulator.snapshot();
      const service = system.services.find((candidate) => candidate.id === serviceId);
      if (!service) {
        json(response, 404, { error: "Service not found", requestId });
        return;
      }
      const byId = new Map(system.services.map((candidate) => [candidate.id, candidate]));
      const incidents = relatedIncidentsForService(incidentManager, serviceId);
      json(response, 200, {
        service,
        history: simulator.history(serviceId),
        logs: simulator.recentLogs(serviceId),
        deployments: simulator.recentDeployments(serviceId),
        dependencies: service.dependencies.map((dependencyId) => byId.get(dependencyId)).filter((dependency): dependency is NonNullable<typeof dependency> => dependency !== undefined),
        dependents: system.services.filter((candidate) => candidate.dependencies.includes(serviceId)),
        activeAlerts: incidentManager.activeAlertsFor(serviceId),
        relatedIncidents: incidents,
      });
      return;
    }
    if (url.pathname === "/api/alert-policies") {
      if (request.method === "GET") {
        json(response, 200, { policies: alertPolicies.list() });
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      try {
        const policy = alertPolicies.create(await readJson(request));
        incidentManager.setPolicies(alertPolicies.list());
        json(response, 201, { policy });
      } catch (error) {
        json(response, 400, { error: policyErrorMessage(error), requestId });
      }
      return;
    }
    if (url.pathname.startsWith("/api/alert-policies/")) {
      if (request.method !== "PUT") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      const policyId = decodeURIComponent(url.pathname.slice("/api/alert-policies/".length));
      try {
        const policy = alertPolicies.update(policyId, await readJson(request));
        incidentManager.setPolicies(alertPolicies.list());
        json(response, 200, { policy });
      } catch (error) {
        if (error instanceof AlertPolicyNotFoundError) {
          json(response, 404, { error: error.message, requestId });
          return;
        }
        json(response, 400, { error: policyErrorMessage(error), requestId });
      }
      return;
    }
    if (url.pathname === "/api/incidents") {
      const status = url.searchParams.get("status");
      const severity = url.searchParams.get("severity");
      if (!isIncidentStatus(status) || !isIncidentSeverity(severity)) {
        json(response, 400, { error: "status and severity filters must be valid incident values", requestId });
        return;
      }
      const incidents = incidentManager.list().filter((incident) =>
        (status === null || incident.status === status) && (severity === null || incident.severity === severity),
      );
      json(response, 200, { incidents });
      return;
    }
    if (url.pathname.startsWith("/api/incidents/") && url.pathname.endsWith("/investigate")) {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      const incidentId = url.pathname.slice("/api/incidents/".length, -"/investigate".length);
      const incident = incidentManager.find(incidentId);
      if (!incident) {
        json(response, 404, { error: "Incident not found", requestId });
        return;
      }
      const evidence = incidentManager.evidenceFor(incidentId);
      if (!evidence) {
        json(response, 409, { error: "Incident evidence is not available", requestId });
        return;
      }
      const context = {
        incident: { ...incident, timeline: incident.timeline.filter(isInvestigationTimelineEvent) },
        services: evidence.topology,
        metricHistories: evidence.metricHistories,
      };
      let analysis: Investigation;
      try {
        analysis = await investigator.investigate(context);
      } catch {
        log("investigation_provider_fallback", { requestId, reason: "provider_unavailable" });
        analysis = { ...deterministicInvestigator.investigate(context), fallbackReason: "AI provider unavailable; offline evidence analysis shown." };
      }
      incidentManager.recordInvestigation({
        incidentId,
        timestamp: simulator.snapshot().timestamp,
        hypothesis: analysis.hypotheses[0]?.inference ?? "No hypothesis could be generated from the available evidence.",
        suggestedAction: analysis.suggestedAction,
      });
      json(response, 200, analysis);
      return;
    }
    if (url.pathname.startsWith("/api/incidents/") && url.pathname.endsWith("/evidence")) {
      const incidentId = url.pathname.slice("/api/incidents/".length, -"/evidence".length);
      const evidence = incidentManager.evidenceFor(incidentId);
      if (!evidence) {
        json(response, 404, { error: "Incident evidence not found", requestId });
        return;
      }
      json(response, 200, evidence);
      return;
    }
    if (url.pathname.startsWith("/api/incidents/") && url.pathname.endsWith("/resolve")) {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      const incidentId = decodeURIComponent(url.pathname.slice("/api/incidents/".length, -"/resolve".length));
      try {
        const incident = incidentManager.resolve(incidentId, simulator.snapshot().timestamp, "Engineer (demo)");
        json(response, 200, incident);
      } catch (error) {
        const status = error instanceof IncidentResolutionError && error.message === "Incident not found" ? 404 : 409;
        json(response, status, { error: error instanceof Error ? error.message : "Unable to resolve incident", requestId });
      }
      return;
    }
    const actionRoute = incidentActionRoute(url.pathname);
    if (actionRoute) {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      if (actionRoute.operation === "execute") {
        json(response, 409, { error: "Suggested actions execute only through explicit approval", requestId });
        return;
      }
      const timestamp = simulator.snapshot().timestamp;
      try {
        if (actionRoute.operation === "reject") {
          const reason = actionRejectionReason(await readJson(request));
          incidentManager.rejectAction(actionRoute.incidentId, actionRoute.actionId, timestamp, "Engineer (demo)", reason);
        } else {
          const approved = incidentManager.approveAction(actionRoute.incidentId, actionRoute.actionId, timestamp, "Engineer (demo)");
          const executing = incidentManager.beginActionExecution(actionRoute.incidentId, approved.id, timestamp);
          const result = simulator.rollbackDeployment({
            serviceId: executing.targetServiceId as ServiceId,
            fromVersion: executing.fromVersion,
            toVersion: executing.toVersion,
          });
          if (result.ok) {
            incidentManager.completeAction(actionRoute.incidentId, executing.id, timestamp, result.message);
          } else {
            incidentManager.failAction(actionRoute.incidentId, executing.id, timestamp, result.message);
          }
        }
        const incident = incidentManager.find(actionRoute.incidentId);
        if (!incident) throw new IncidentActionError("Incident not found");
        json(response, 200, incident);
      } catch (error) {
        const message = actionErrorMessage(error);
        const status = message.includes("not found") ? 404 : 409;
        json(response, status, { error: message, requestId });
      }
      return;
    }
    if (url.pathname.startsWith("/api/incidents/")) {
      const incidentId = url.pathname.slice("/api/incidents/".length);
      const incident = incidentManager.find(incidentId);
      if (!incident) {
        json(response, 404, { error: "Incident not found", requestId });
        return;
      }
      json(response, 200, incident);
      return;
    }
    if (url.pathname === "/api/simulator/bad-payment-deployment") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      simulator.triggerBadPaymentDeployment();
      json(response, 202, { scenario: "bad-payment-deployment" });
      return;
    }
    if (url.pathname === "/api/simulator/redis-degradation") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      simulator.triggerRedisDegradation();
      json(response, 202, { scenario: "redis-degradation" });
      return;
    }
    if (url.pathname === "/api/simulator/kafka-backlog") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      simulator.triggerKafkaBacklog();
      json(response, 202, { scenario: "kafka-backlog" });
      return;
    }
    if (url.pathname === "/api/simulator/service-outage") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      try {
        const serviceId = outageServiceId(await readJson(request));
        simulator.triggerServiceOutage(serviceId);
        json(response, 202, { scenario: "service-outage", serviceId });
      } catch (error) {
        json(response, 400, { error: outageErrorMessage(error), requestId });
      }
      return;
    }
    if (url.pathname === "/api/simulator/recover") {
      if (request.method !== "POST") {
        json(response, 405, { error: "Method not allowed", requestId });
        return;
      }
      simulator.recover();
      json(response, 202, { scenario: "recovering" });
      return;
    }
    if (url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write("retry: 2000\n\n");
      response.write(`event: telemetry\ndata: ${JSON.stringify(simulator.current())}\n\n`);
      response.write(`event: system\ndata: ${JSON.stringify({ type: "system", system: simulator.snapshot() })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (asset === "index.html" || asset === "incident.html" || asset === "services.html" || asset === "service.html" || asset === "incidents.html" || asset === "styles.css" || asset === "app.js" || asset === "incident.js" || asset === "services.js" || asset === "service.js" || asset === "incidents.js" || asset === "topology.js" || asset === "investigation-view.js" || asset === "scenario-controls.js" || asset === "incident-metrics.js") {
      try {
        const body = await readFile(join(webRoot, asset));
        const contentType = asset.endsWith(".css") ? "text/css" : asset.endsWith(".js") ? "application/javascript" : "text/html";
        response.writeHead(200, { "content-type": `${contentType}; charset=utf-8` });
        response.end(body);
      } catch {
        json(response, 404, { error: "Asset not found", requestId });
      }
      return;
    }
    json(response, 404, { error: "Route not found", requestId });
  });

  if (options.autoStart !== false) interval = setInterval(() => simulator.advance(), options.tickIntervalMs ?? 2_000);
  return {
    advance: () => simulator.advance(),
    triggerBadPaymentDeployment: () => simulator.triggerBadPaymentDeployment(),
    triggerRedisDegradation: () => simulator.triggerRedisDegradation(),
    triggerKafkaBacklog: () => simulator.triggerKafkaBacklog(),
    triggerServiceOutage: (serviceId) => simulator.triggerServiceOutage(serviceId),
    recover: () => simulator.recover(),
    listen: () => new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Unable to resolve bound API address");
      resolve(`http://127.0.0.1:${address.port}`);
    })),
    close: () => new Promise((resolve, reject) => {
      if (interval) clearInterval(interval);
      unsubscribe();
      unsubscribeIncidents();
      for (const stream of streams) stream.end();
      httpServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function configuredInvestigator(fallback: DeterministicInvestigator): IncidentInvestigator {
  if (process.env.AI_INCIDENT_COMMANDER_AI_PROVIDER !== "gemini" || !process.env.GEMINI_API_KEY) return fallback;
  return new GeminiInvestigator(new GeminiGenerateContentTransport({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
  }), fallback);
}

function broadcast(streams: ReadonlySet<ServerResponse>, event: SimulatorEvent | IncidentEvent): void {
  const streamEvent = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) stream.write(streamEvent);
}

function isServiceId(value: string | null): value is ServiceId {
  return value !== null && serviceIds.includes(value as ServiceId);
}

function isIncidentStatus(value: string | null): value is "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED" | null {
  return value === null || value === "DETECTED" || value === "INVESTIGATING" || value === "MONITORING" || value === "RESOLVED";
}

function isIncidentSeverity(value: string | null): value is "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4" | null {
  return value === null || value === "SEV-1" || value === "SEV-2" || value === "SEV-3" || value === "SEV-4";
}

function relatedIncidentsForService(incidentManager: IncidentManager, serviceId: string) {
  return incidentManager.list().filter((incident) =>
    incident.affectedServices.includes(serviceId) || incidentManager.evidenceFor(incident.id)?.contextServiceIds.includes(serviceId),
  );
}

async function readJson(request: AsyncIterable<unknown>): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 16_384) throw new AlertPolicyValidationError("Request body is too large");
  }
  if (body.length === 0) throw new AlertPolicyValidationError("A JSON request body is required");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AlertPolicyValidationError("Request body must be valid JSON");
  }
}

function policyErrorMessage(error: unknown): string {
  return error instanceof AlertPolicyValidationError ? error.message : "Unable to update alert policy";
}

function outageServiceId(value: unknown): ServiceId {
  const candidate = isRecord(value) && typeof value.serviceId === "string" ? value.serviceId : null;
  if (!isServiceId(candidate)) {
    throw new Error("serviceId must be a known simulated service");
  }
  return candidate;
}

function outageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to start service outage";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInvestigationTimelineEvent(event: { readonly type: string }): event is { readonly type: "DEPLOYMENT" | "LOG" | "ALERT_TRIGGERED" | "INCIDENT_CREATED"; readonly timestamp: string; readonly message: string; readonly serviceId?: string; readonly version?: string; readonly previousVersion?: string; readonly deploymentKind?: "RELEASE" | "ROLLBACK" } {
  return event.type === "DEPLOYMENT" || event.type === "LOG" || event.type === "ALERT_TRIGGERED" || event.type === "INCIDENT_CREATED";
}

function incidentActionRoute(pathname: string): { readonly incidentId: string; readonly actionId: string; readonly operation: "approve" | "reject" | "execute" } | undefined {
  const match = /^\/api\/incidents\/([^/]+)\/actions\/([^/]+)\/(approve|reject|execute)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return { incidentId: decodeURIComponent(match[1] ?? ""), actionId: decodeURIComponent(match[2] ?? ""), operation: match[3] as "approve" | "reject" | "execute" };
  } catch {
    return undefined;
  }
}

function actionRejectionReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string" || value.reason.trim().length === 0) throw new IncidentActionError("A non-empty rejection reason is required");
  return value.reason.trim();
}

function actionErrorMessage(error: unknown): string {
  return error instanceof IncidentActionError ? error.message : "Unable to update suggested action";
}

if (process.argv[1]?.endsWith("server.ts")) {
  const app = createServer();
  app.listen().then((address) => log("server_started", { address }));
}
