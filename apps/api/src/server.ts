import { createServer as createHttpServer, type Server } from "node:http";

import { isServiceId, serviceIds, TelemetrySimulator, type ServiceId, type SimulatorEvent, type TelemetrySample } from "./simulator.ts";
import { IncidentManager, type IncidentEvent } from "./incident-manager.ts";
import { AlertPolicyStore } from "./alert-policy-store.ts";
import { DemoSessionStore } from "./demo-session-store.ts";
import { DeterministicInvestigator, type IncidentInvestigator } from "../../../packages/ai/src/deterministic-investigator.ts";
import { GeminiGenerateContentTransport, GeminiInvestigator } from "../../../packages/ai/src/gemini-investigator.ts";
import { IncidentInvestigation } from "./incidents/incident-investigation.ts";
import { SuggestedActionDecisions } from "./incidents/suggested-action-decisions.ts";
import type { Clock, MitigationExecutor } from "./incidents/ports.ts";
import { log } from "./http/http-kit.ts";
import { createRouter } from "./http/router.ts";
import { EventStream } from "./http/event-stream.ts";
import { serveStaticAsset } from "./http/static-assets.ts";
import { sessionRoutes } from "./http/session-routes.ts";
import { telemetryRoutes } from "./http/telemetry-routes.ts";
import { serviceRoutes } from "./http/service-routes.ts";
import { alertPolicyRoutes } from "./http/alert-policy-routes.ts";
import { incidentRoutes } from "./http/incident-routes.ts";
import { actionRoutes } from "./http/action-routes.ts";
import { simulatorRoutes } from "./http/simulator-routes.ts";

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

// Composition root: wires the simulator, in-memory stores, investigator, and HTTP adapter together.
export function createServer(options: AppOptions = {}): RunningApp {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date() });
  const alertPolicies = new AlertPolicyStore(serviceIds);
  const incidentManager = new IncidentManager({ policies: alertPolicies.list() });
  const deterministicInvestigator = new DeterministicInvestigator();
  const investigator = options.investigator ?? configuredInvestigator(deterministicInvestigator);
  const sessions = new DemoSessionStore();
  const events = new EventStream(simulator);
  const unsubscribe = simulator.subscribe((event: SimulatorEvent) => {
    events.broadcast(event);
    incidentManager.observe(event);
  });
  const unsubscribeIncidents = incidentManager.subscribe((event: IncidentEvent) => events.broadcast(event));
  incidentManager.observe({ type: "system", system: simulator.snapshot() });
  let interval: NodeJS.Timeout | undefined;

  const clock: Clock = { now: () => simulator.snapshot().timestamp };
  const investigation = new IncidentInvestigation({ incidents: incidentManager, investigator, fallbackInvestigator: deterministicInvestigator, clock });
  const decisions = new SuggestedActionDecisions({ incidents: incidentManager, mitigations: simulatorMitigations(simulator), clock });

  const router = createRouter([
    ...telemetryRoutes(simulator, incidentManager),
    ...sessionRoutes(sessions),
    ...serviceRoutes(simulator, incidentManager),
    ...alertPolicyRoutes(alertPolicies, incidentManager),
    ...incidentRoutes({ incidentManager, investigation, sessions, clock }),
    ...actionRoutes(decisions, sessions),
    ...simulatorRoutes(simulator),
    events.route(),
  ], serveStaticAsset);
  const httpServer: Server = createHttpServer(router);

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
      events.closeAll();
      httpServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

// The simulator is the only mitigation target today; a service outside its topology cannot be rolled back.
function simulatorMitigations(simulator: TelemetrySimulator): MitigationExecutor {
  return {
    rollbackDeployment: ({ serviceId, fromVersion, toVersion }) => isServiceId(serviceId)
      ? simulator.rollbackDeployment({ serviceId, fromVersion, toVersion })
      : { ok: false, message: `${serviceId} is not a simulated service` },
  };
}

function configuredInvestigator(fallback: DeterministicInvestigator): IncidentInvestigator {
  if (process.env.AI_INCIDENT_COMMANDER_AI_PROVIDER !== "gemini" || !process.env.GEMINI_API_KEY) return fallback;
  return new GeminiInvestigator(new GeminiGenerateContentTransport({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
  }), fallback);
}

if (process.argv[1]?.endsWith("server.ts")) {
  const app = createServer();
  app.listen().then((address) => log("server_started", { address }));
}
