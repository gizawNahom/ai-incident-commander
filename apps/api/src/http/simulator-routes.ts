import type { ServiceId, TelemetrySimulator } from "../simulator.ts";
import { isRecord, json, readJson, sendError, type Route } from "./http-kit.ts";
import { isServiceId } from "./telemetry-routes.ts";

export function simulatorRoutes(simulator: TelemetrySimulator): readonly Route[] {
  return [
    scenario("bad-payment-deployment", () => simulator.triggerBadPaymentDeployment()),
    scenario("redis-degradation", () => simulator.triggerRedisDegradation()),
    scenario("kafka-backlog", () => simulator.triggerKafkaBacklog()),
    {
      pattern: /^\/api\/simulator\/service-outage$/,
      handle: {
        POST: async (context) => {
          try {
            const serviceId = outageServiceId(await readJson(context.request));
            simulator.triggerServiceOutage(serviceId);
            json(context.response, 202, { scenario: "service-outage", serviceId });
          } catch (error) {
            sendError(context, 400, error instanceof Error ? error.message : "Unable to start service outage");
          }
        },
      },
    },
    {
      pattern: /^\/api\/simulator\/recover$/,
      handle: {
        POST: ({ response }) => {
          simulator.recover();
          json(response, 202, { scenario: "recovering" });
        },
      },
    },
  ];
}

function scenario(name: string, trigger: () => void): Route {
  return {
    pattern: new RegExp(`^/api/simulator/${name}$`),
    handle: {
      POST: ({ response }) => {
        trigger();
        json(response, 202, { scenario: name });
      },
    },
  };
}

function outageServiceId(value: unknown): ServiceId {
  const candidate = isRecord(value) && typeof value.serviceId === "string" ? value.serviceId : null;
  if (!isServiceId(candidate)) {
    throw new Error("serviceId must be a known simulated service");
  }
  return candidate;
}
