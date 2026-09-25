import type { ServerResponse } from "node:http";

import type { SimulatorEvent, TelemetrySimulator } from "../simulator.ts";
import type { IncidentEvent } from "../incident-manager.ts";
import type { Route } from "./http-kit.ts";

// Server-sent events fan-out for live dashboard updates (ADR-0002).
export class EventStream {
  private readonly streams = new Set<ServerResponse>();
  private readonly simulator: TelemetrySimulator;

  constructor(simulator: TelemetrySimulator) {
    this.simulator = simulator;
  }

  route(): Route {
    return {
      pattern: /^\/api\/events$/,
      handle: ({ request, response }) => {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write("retry: 2000\n\n");
        response.write(`event: telemetry\ndata: ${JSON.stringify(this.simulator.current())}\n\n`);
        response.write(`event: system\ndata: ${JSON.stringify({ type: "system", system: this.simulator.snapshot() })}\n\n`);
        this.streams.add(response);
        request.on("close", () => this.streams.delete(response));
      },
    };
  }

  broadcast(event: SimulatorEvent | IncidentEvent): void {
    const streamEvent = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) stream.write(streamEvent);
  }

  closeAll(): void {
    for (const stream of this.streams) stream.end();
  }
}
