import { createServer as createHttpServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { serviceIds, TelemetrySimulator, type ServiceId, type SimulatorEvent, type TelemetrySample } from "./simulator.ts";
import { IncidentManager, type IncidentEvent } from "./incident-manager.ts";
import { AlertPolicyNotFoundError, AlertPolicyStore, AlertPolicyValidationError } from "./alert-policy-store.ts";
import { DeterministicInvestigator, type IncidentInvestigator, type Investigation } from "../../../packages/ai/src/deterministic-investigator.ts";
import { GeminiGenerateContentTransport, GeminiInvestigator } from "../../../packages/ai/src/gemini-investigator.ts";

type AppOptions = { readonly autoStart?: boolean; readonly investigator?: IncidentInvestigator };
type RunningApp = {
  listen: () => Promise<string>;
  close: () => Promise<void>;
  advance: () => TelemetrySample;
  triggerBadPaymentDeployment: () => void;
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
      json(response, 200, { incidents: incidentManager.list() });
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
      const system = simulator.snapshot();
      const context = {
        incident,
        services: system.services,
        metricHistories: system.services.map((service) => simulator.history(service.id)),
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
        timestamp: system.timestamp,
        hypothesis: analysis.hypotheses[0]?.inference ?? "No hypothesis could be generated from the available evidence.",
        suggestedAction: analysis.suggestedAction ? `Rollback ${analysis.suggestedAction.targetServiceId} proposed` : undefined,
      });
      json(response, 200, analysis);
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
    if (asset === "index.html" || asset === "incident.html" || asset === "styles.css" || asset === "app.js" || asset === "incident.js" || asset === "topology.js" || asset === "investigation-view.js") {
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

  if (options.autoStart !== false) interval = setInterval(() => simulator.advance(), 2_000);
  return {
    advance: () => simulator.advance(),
    triggerBadPaymentDeployment: () => simulator.triggerBadPaymentDeployment(),
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

if (process.argv[1]?.endsWith("server.ts")) {
  const app = createServer();
  app.listen().then((address) => log("server_started", { address }));
}
