import assert from "node:assert/strict";
import test from "node:test";

import { TelemetrySimulator } from "../src/simulator.ts";

test("the healthy simulator publishes an API Gateway latency sample when it advances", () => {
  const simulator = new TelemetrySimulator({ seed: 1042, now: () => new Date("2026-08-13T12:00:00.000Z") });
  const samples = [];
  simulator.subscribe((sample) => samples.push(sample));

  simulator.advance();

  assert.equal(samples.length, 1);
  assert.equal(samples[0].serviceId, "api-gateway");
  assert.equal(samples[0].metric, "latency_ms");
  assert.ok(samples[0].value >= 80 && samples[0].value <= 130);
});
