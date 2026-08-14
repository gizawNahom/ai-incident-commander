import assert from "node:assert/strict";
import test from "node:test";

import { Incident, IncidentStatus } from "../src/incident.ts";

test("an incident can only move through its allowed investigation lifecycle", () => {
  const incident = Incident.detect({
    id: "inc_1042",
    title: "Checkout payment failures",
    severity: "SEV_1",
    startedAt: new Date("2026-08-13T12:04:20.000Z"),
  });

  assert.equal(incident.status, IncidentStatus.DETECTED);
  assert.throws(() => incident.transitionTo(IncidentStatus.MITIGATING));

  incident.transitionTo(IncidentStatus.INVESTIGATING);
  incident.transitionTo(IncidentStatus.IDENTIFIED);
  assert.equal(incident.status, IncidentStatus.IDENTIFIED);
});
