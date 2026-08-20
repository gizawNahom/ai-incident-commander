import assert from "node:assert/strict";

import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";

import { createServer } from "../../api/src/server.ts";

type Application = ReturnType<typeof createServer>;
type Incident = {
  readonly id: string;
  readonly status: "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED";
  readonly affectedServices: readonly string[];
  readonly timeline: readonly { readonly type: string; readonly message: string }[];
};
type IncidentEvidence = {
  readonly deployments: readonly { readonly message: string }[];
  readonly metricHistories: readonly { readonly serviceId: string; readonly samples: readonly { readonly latencyMs?: number }[] }[];
};
type System = { readonly services: readonly { readonly health: string }[] };

class IncidentWorld {
  app: Application | undefined;
  address: string | undefined;
  incidentId: string | undefined;
  observedIncident: Incident | undefined;
  separateIncident: Incident | undefined;
}

setWorldConstructor(IncidentWorld);

Before(async function (this: IncidentWorld) {
  this.app = createServer({ autoStart: false });
  this.address = await this.app.listen();
});

After(async function (this: IncidentWorld) {
  await this.app?.close();
});

Given("the production system is healthy", async function (this: IncidentWorld) {
  const system = await getJson<System>(this, "/api/system");
  assert.ok(system.services.every((service) => service.health === "healthy"));
});

When("payment-service version 1.8.3 is released", async function (this: IncidentWorld) {
  await post(this, "/api/simulator/bad-payment-deployment");
  advance(this, 3);
});

Then("a checkout degradation incident is opened", async function (this: IncidentWorld) {
  const incidents = await getIncidents(this);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.status, "DETECTED");
  assert.match(incidents[0]?.id ?? "", /^INC-/);
  this.incidentId = incidents[0]?.id;
  this.observedIncident = incidents[0];
});

Then("the incident record contains the release evidence", async function (this: IncidentWorld) {
  const evidence = await getEvidence(this);
  assert.ok(evidence.deployments.some((deployment) => deployment.message.includes("payment-service v1.8.3 deployment completed")));
});

Given("a payment incident is being investigated", async function (this: IncidentWorld) {
  await createPaymentIncident(this);
});

When("the affected payment path remains healthy", async function (this: IncidentWorld) {
  await post(this, "/api/simulator/recover");
  advance(this, 6);
});

Then("the incident is monitoring recovery", async function (this: IncidentWorld) {
  const incident = await getIncident(this);
  assert.equal(incident.status, "MONITORING");
  this.observedIncident = incident;
});

Then("its incident record retains the earlier failure evidence", async function (this: IncidentWorld) {
  const evidence = await getEvidence(this);
  const paymentHistory = evidence.metricHistories.find((history) => history.serviceId === "payment-service");
  assert.ok(paymentHistory?.samples.some((sample) => (sample.latencyMs ?? 0) > 1_000));
});

Given("a payment incident is monitoring recovery", async function (this: IncidentWorld) {
  await createPaymentIncident(this);
  await post(this, "/api/simulator/recover");
  advance(this, 6);
  assert.equal((await getIncident(this)).status, "MONITORING");
});

When("the engineer resolves the incident", async function (this: IncidentWorld) {
  this.observedIncident = await post<Incident>(this, `/api/incidents/${incidentId(this)}/resolve`);
});

Then("the incident is resolved", async function (this: IncidentWorld) {
  assert.equal((await getIncident(this)).status, "RESOLVED");
});

Then("the audit timeline says the engineer resolved it", function (this: IncidentWorld) {
  assert.ok(this.observedIncident?.timeline.some((event) => event.type === "INCIDENT_RESOLVED" && event.message.includes("Engineer (demo)")));
});

When("the payment path deteriorates again", async function (this: IncidentWorld) {
  await post(this, "/api/simulator/bad-payment-deployment");
  advance(this, 3);
});

Then("the existing incident returns to investigation", async function (this: IncidentWorld) {
  const incident = await getIncident(this);
  assert.equal(incident.status, "INVESTIGATING");
  assert.equal(incident.id, incidentId(this));
});

Then("no duplicate payment incident is opened", async function (this: IncidentWorld) {
  assert.equal((await getIncidents(this)).length, 1);
});

When("Kafka processing falls behind", async function (this: IncidentWorld) {
  await post(this, "/api/simulator/kafka-backlog");
  advance(this, 3);
});

Then("a separate incident is opened for the Kafka delay", async function (this: IncidentWorld) {
  const incidents = await getIncidents(this);
  assert.equal(incidents.length, 2);
  const separate = incidents.find((incident) => incident.id !== this.incidentId);
  assert.ok(separate, "Expected a second incident record");
  assert.equal(separate.status, "DETECTED");
  assert.ok(separate.affectedServices.includes("kafka"));
  this.separateIncident = separate;
});

Then("the payment incident remains monitoring recovery", async function (this: IncidentWorld) {
  assert.equal((await getIncident(this)).status, "MONITORING");
});

async function createPaymentIncident(world: IncidentWorld): Promise<void> {
  await post(world, "/api/simulator/bad-payment-deployment");
  advance(world, 3);
  const [incident] = await getIncidents(world);
  assert.ok(incident, "Expected a payment incident to be created");
  world.incidentId = incident.id;
}

function advance(world: IncidentWorld, count: number): void {
  const app = world.app;
  if (!app) throw new Error("Acceptance test application is not running");
  for (let tick = 0; tick < count; tick += 1) app.advance();
}

function incidentId(world: IncidentWorld): string {
  if (!world.incidentId) throw new Error("Acceptance scenario has no incident");
  return encodeURIComponent(world.incidentId);
}

async function getIncidents(world: IncidentWorld): Promise<readonly Incident[]> {
  const payload = await getJson<{ readonly incidents: readonly Incident[] }>(world, "/api/incidents");
  return payload.incidents;
}

async function getIncident(world: IncidentWorld): Promise<Incident> {
  return getJson<Incident>(world, `/api/incidents/${incidentId(world)}`);
}

async function getEvidence(world: IncidentWorld): Promise<IncidentEvidence> {
  return getJson<IncidentEvidence>(world, `/api/incidents/${incidentId(world)}/evidence`);
}

async function getJson<T>(world: IncidentWorld, path: string): Promise<T> {
  const response = await fetch(`${address(world)}${path}`);
  if (!response.ok) throw new Error(`Expected ${path} to succeed, received ${response.status}`);
  return await response.json() as T;
}

async function post<T = void>(world: IncidentWorld, path: string): Promise<T> {
  const response = await fetch(`${address(world)}${path}`, { method: "POST" });
  if (!response.ok) throw new Error(`Expected ${path} to succeed, received ${response.status}`);
  return await response.json() as T;
}

function address(world: IncidentWorld): string {
  if (!world.address) throw new Error("Acceptance test application is not listening");
  return world.address;
}
