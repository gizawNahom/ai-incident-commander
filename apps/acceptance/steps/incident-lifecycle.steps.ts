import assert from "node:assert/strict";

import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";

import { createServer } from "../../api/src/server.ts";

type Application = ReturnType<typeof createServer>;
type Incident = {
  readonly id: string;
  readonly title: string;
  readonly severity: "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4";
  readonly status: "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED";
  readonly startedAt: string;
  readonly resolvedAt?: string;
  readonly affectedServices: readonly string[];
  readonly timeline: readonly { readonly type: string; readonly message: string }[];
  readonly actions: readonly SuggestedAction[];
};
type SuggestedAction = {
  readonly id: string;
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly targetServiceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly status: "PROPOSED" | "APPROVED" | "REJECTED" | "EXECUTING" | "COMPLETED" | "FAILED";
  readonly actor?: string;
  readonly decisionReason?: string;
};
type IncidentEvidence = {
  readonly deployments: readonly { readonly message: string }[];
  readonly metricHistories: readonly { readonly serviceId: string; readonly samples: readonly { readonly latencyMs?: number }[] }[];
};
type System = { readonly services: readonly { readonly health: string }[] };
type ServiceListItem = {
  readonly id: string;
  readonly health: string;
  readonly metrics: { readonly latencyMs: number; readonly errorRate: number; readonly trafficRpm: number };
  readonly activeAlertCount: number;
};
type ServiceDetail = {
  readonly service: ServiceListItem & { readonly version: string };
  readonly history: { readonly samples: readonly { readonly latencyMs: number }[] };
  readonly logs: readonly { readonly serviceId: string; readonly message: string }[];
  readonly deployments: readonly { readonly serviceId: string; readonly version: string }[];
  readonly dependencies: readonly { readonly id: string }[];
  readonly dependents: readonly { readonly id: string }[];
  readonly activeAlerts: readonly { readonly serviceId: string }[];
  readonly relatedIncidents: readonly Incident[];
};

class IncidentWorld {
  app: Application | undefined;
  address: string | undefined;
  incidentId: string | undefined;
  observedIncident: Incident | undefined;
  separateIncident: Incident | undefined;
  actionId: string | undefined;
  lastResponseStatus: number | undefined;
  services: readonly ServiceListItem[] = [];
  serviceDetail: ServiceDetail | undefined;
  incidentHistory: readonly Incident[] = [];
  activeIncidentId: string | undefined;
  resolvedIncidentId: string | undefined;
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

Given("a deployment incident has a proposed rollback for {string} from {string} to {string}", async function (this: IncidentWorld, serviceId: string, fromVersion: string, toVersion: string) {
  assert.equal(serviceId, "payment-service", "The seeded demo currently supplies the payment deployment example");
  assert.equal(fromVersion, "v1.8.3");
  assert.equal(toVersion, "v1.8.2");
  await createPaymentIncident(this);
  const analysis = await post<{ readonly suggestedAction?: { readonly targetServiceId: string } }>(this, `/api/incidents/${incidentId(this)}/investigate`);
  assert.equal(analysis.suggestedAction?.targetServiceId, serviceId);
  const incident = await getIncident(this);
  const action = incident.actions.find((candidate) => candidate.targetServiceId === serviceId && candidate.fromVersion === fromVersion && candidate.toVersion === toVersion);
  assert.ok(action, "Expected the proposed rollback to be retained on the incident");
  assert.equal(action.status, "PROPOSED");
  this.actionId = action.id;
});

When(/^Engineer \(demo\) approves the rollback$/, async function (this: IncidentWorld) {
  this.observedIncident = await post<Incident>(this, `/api/incidents/${incidentId(this)}/actions/${actionId(this)}/approve`);
});

Then("{string} is rolled back to version {string}", async function (this: IncidentWorld, serviceId: string, version: string) {
  const system = await getJson<{ readonly services: readonly { readonly id: string; readonly version: string }[] }>(this, "/api/system");
  assert.equal(system.services.find((service) => service.id === serviceId)?.version, version);
});

Then("{string} remains on version {string}", async function (this: IncidentWorld, serviceId: string, version: string) {
  const system = await getJson<{ readonly services: readonly { readonly id: string; readonly version: string }[] }>(this, "/api/system");
  assert.equal(system.services.find((service) => service.id === serviceId)?.version, version);
});

Then("the rollback is completed and audited for {string}", async function (this: IncidentWorld, serviceId: string) {
  const incident = this.observedIncident ?? await getIncident(this);
  const action = incident.actions.find((candidate) => candidate.id === actionId(this));
  assert.equal(action?.status, "COMPLETED");
  assert.equal(action?.actor, "Engineer (demo)");
  assert.ok(incident.timeline.some((event) => event.type === "ACTION_APPROVED" && event.message.includes(serviceId)));
  assert.ok(incident.timeline.some((event) => event.type === "ACTION_EXECUTED" && event.message.includes(serviceId)));
  assert.ok(incident.timeline.some((event) => event.type === "ACTION_COMPLETED" && event.message.includes(serviceId)));
});

When(/^Engineer \(demo\) rejects the rollback because "([^"]+)"$/, async function (this: IncidentWorld, reason: string) {
  this.observedIncident = await postJson<Incident>(this, `/api/incidents/${incidentId(this)}/actions/${actionId(this)}/reject`, { reason });
});

Then("the rejected rollback is audited with reason {string}", async function (this: IncidentWorld, reason: string) {
  const incident = this.observedIncident ?? await getIncident(this);
  const action = incident.actions.find((candidate) => candidate.id === actionId(this));
  assert.equal(action?.status, "REJECTED");
  assert.equal(action?.actor, "Engineer (demo)");
  assert.equal(action?.decisionReason, reason);
  assert.ok(incident.timeline.some((event) => event.type === "ACTION_REJECTED" && event.message.includes(reason)));
});

When("a caller attempts to execute the proposed rollback directly", async function (this: IncidentWorld) {
  const response = await fetch(`${address(this)}/api/incidents/${incidentId(this)}/actions/${actionId(this)}/execute`, { method: "POST" });
  this.lastResponseStatus = response.status;
});

Given("a resolved payment incident has a proposed rollback", async function (this: IncidentWorld) {
  await createPaymentIncident(this);
  await post(this, "/api/simulator/recover");
  advance(this, 6);
  assert.equal((await getIncident(this)).status, "MONITORING");
  await post(this, `/api/incidents/${incidentId(this)}/investigate`);
  const incidentWithAction = await getIncident(this);
  const action = incidentWithAction.actions[0];
  assert.ok(action, "Expected a rollback proposal before resolution");
  this.actionId = action.id;
  await post(this, `/api/incidents/${incidentId(this)}/resolve`);
});

When("a caller attempts to approve the proposed rollback", async function (this: IncidentWorld) {
  const response = await fetch(`${address(this)}/api/incidents/${incidentId(this)}/actions/${actionId(this)}/approve`, { method: "POST" });
  this.lastResponseStatus = response.status;
});

Then("the attempted rollback is rejected", function (this: IncidentWorld) {
  assert.equal(this.lastResponseStatus, 409);
});

Then("the rollback remains proposed", async function (this: IncidentWorld) {
  const action = (await getIncident(this)).actions.find((candidate) => candidate.id === actionId(this));
  assert.equal(action?.status, "PROPOSED");
});

Given("the simulated system is healthy", async function (this: IncidentWorld) {
  const system = await getJson<System>(this, "/api/system");
  assert.ok(system.services.every((service) => service.health === "healthy"));
});

When("the engineer opens the Services screen", async function (this: IncidentWorld) {
  const response = await fetch(`${address(this)}/services.html`);
  assert.equal(response.status, 200);
  this.services = (await getJson<{ readonly services: readonly ServiceListItem[] }>(this, "/api/services")).services;
});

Then("they see every monitored service", function (this: IncidentWorld) {
  assert.equal(this.services.length, 9);
});

Then("each service shows its current health, latency, error rate, traffic, and active-alert count", function (this: IncidentWorld) {
  assert.ok(this.services.every((service) => typeof service.health === "string" && Number.isFinite(service.metrics.latencyMs) && Number.isFinite(service.metrics.errorRate) && Number.isFinite(service.metrics.trafficRpm) && Number.isInteger(service.activeAlertCount)));
});

Then("each service links to its service detail", async function (this: IncidentWorld) {
  for (const service of this.services) {
    const response = await fetch(`${address(this)}/service.html?id=${encodeURIComponent(service.id)}`);
    assert.equal(response.status, 200);
  }
});

Given("the {string} service is affected by the {string} scenario", async function (this: IncidentWorld, serviceId: string, scenario: string) {
  if (scenario === "bad deployment") await post(this, "/api/simulator/bad-payment-deployment");
  else if (scenario === "Redis degradation") await post(this, "/api/simulator/redis-degradation");
  else if (scenario === "Kafka backlog") await post(this, "/api/simulator/kafka-backlog");
  else if (scenario === "service outage") await postJson(this, "/api/simulator/service-outage", { serviceId });
  else throw new Error(`Unsupported simulator scenario: ${scenario}`);
  advance(this, 3);
  const service = (await getJson<{ readonly services: readonly { readonly id: string; readonly health: string }[] }>(this, "/api/system")).services.find((candidate) => candidate.id === serviceId);
  assert.ok(service && service.health !== "healthy", `Expected ${serviceId} to be affected by ${scenario}`);
});

When("the engineer opens the service detail for {string}", async function (this: IncidentWorld, serviceId: string) {
  const page = await fetch(`${address(this)}/service.html?id=${encodeURIComponent(serviceId)}`);
  assert.equal(page.status, 200);
  this.serviceDetail = await getJson<ServiceDetail>(this, `/api/services/${encodeURIComponent(serviceId)}`);
});

Then("they see the current metrics for {string}", function (this: IncidentWorld, serviceId: string) {
  assert.equal(this.serviceDetail?.service.id, serviceId);
  assert.ok((this.serviceDetail?.history.samples.length ?? 0) > 0);
  assert.ok(Number.isFinite(this.serviceDetail?.service.metrics.latencyMs));
});

Then("they see recent logs for {string}", function (this: IncidentWorld, serviceId: string) {
  assert.ok(this.serviceDetail?.logs.some((log) => log.serviceId === serviceId));
});

Then("they see the current deployment for {string}", function (this: IncidentWorld, serviceId: string) {
  assert.equal(this.serviceDetail?.service.id, serviceId);
  assert.match(this.serviceDetail?.service.version ?? "", /\S/);
});

Then("they see dependencies and dependent services for {string}", function (this: IncidentWorld, serviceId: string) {
  assert.equal(this.serviceDetail?.service.id, serviceId);
  assert.ok((this.serviceDetail?.dependencies.length ?? 0) + (this.serviceDetail?.dependents.length ?? 0) > 0);
});

Then("they see active alerts affecting {string}", function (this: IncidentWorld, serviceId: string) {
  assert.ok(this.serviceDetail?.activeAlerts.some((alert) => alert.serviceId === serviceId));
});

Then("they can open related incidents for {string}", async function (this: IncidentWorld, serviceId: string) {
  const incident = this.serviceDetail?.relatedIncidents[0];
  assert.ok(incident, `Expected a related incident for ${serviceId}`);
  const response = await fetch(`${address(this)}/incident.html?id=${encodeURIComponent(incident.id)}`);
  assert.equal(response.status, 200);
});

Given("{string} was affected by a bad deployment", async function (this: IncidentWorld, serviceId: string) {
  assert.equal(serviceId, "payment-service");
  await createPaymentIncident(this);
});

Given("the system has recovered", async function (this: IncidentWorld) {
  await post(this, "/api/simulator/recover");
  advance(this, 6);
});

Then("they see the current healthy service state", function (this: IncidentWorld) {
  assert.equal(this.serviceDetail?.service.health, "healthy");
});

Then("they can open the related historical incident record", async function (this: IncidentWorld) {
  const incident = this.serviceDetail?.relatedIncidents[0];
  assert.ok(incident);
  const evidence = await getJson<IncidentEvidence>(this, `/api/incidents/${encodeURIComponent(incident.id)}/evidence`);
  assert.ok(evidence.metricHistories.some((history) => history.samples.some((sample) => (sample.latencyMs ?? 0) > 1_000)));
});

Given("one incident is active", async function (this: IncidentWorld) {
  await createKafkaIncident(this);
  this.activeIncidentId = this.incidentId;
});

Given("one earlier incident has been resolved", async function (this: IncidentWorld) {
  await createAndResolvePaymentIncident(this);
  this.resolvedIncidentId = this.incidentId;
  await createKafkaIncident(this);
  this.activeIncidentId = this.incidentId;
});

Given("there is an active incident", async function (this: IncidentWorld) {
  await createKafkaIncident(this);
  this.activeIncidentId = this.incidentId;
});

Given("there is a resolved incident", async function (this: IncidentWorld) {
  await createAndResolvePaymentIncident(this);
  this.resolvedIncidentId = this.incidentId;
  await createKafkaIncident(this);
  this.activeIncidentId = this.incidentId;
});

When("the engineer opens Incident History", async function (this: IncidentWorld) {
  const page = await fetch(`${address(this)}/incidents.html`);
  assert.equal(page.status, 200);
  this.incidentHistory = (await getJson<{ readonly incidents: readonly Incident[] }>(this, "/api/incidents")).incidents;
});

Then("they see both incidents", function (this: IncidentWorld) {
  assert.ok(this.incidentHistory.some((incident) => incident.id === this.activeIncidentId));
  assert.ok(this.incidentHistory.some((incident) => incident.id === this.resolvedIncidentId));
});

Then("each incident shows its identifier, title, severity, status, affected services, and start time", function (this: IncidentWorld) {
  assert.ok(this.incidentHistory.every((incident) => /^INC-/.test(incident.id) && incident.title.length > 0 && incident.severity.startsWith("SEV-") && incident.status.length > 0 && incident.affectedServices.length > 0 && Number.isFinite(Date.parse(incident.startedAt))));
});

Then("the resolved incident also shows its resolution time", function (this: IncidentWorld) {
  const resolved = this.incidentHistory.find((incident) => incident.id === this.resolvedIncidentId);
  assert.ok(resolved?.resolvedAt && Number.isFinite(Date.parse(resolved.resolvedAt)));
});

When("the engineer filters Incident History to {string}", async function (this: IncidentWorld, filter: string) {
  const query = filter === "Resolved" ? "status=RESOLVED" : `severity=${encodeURIComponent(filter)}`;
  this.incidentHistory = (await getJson<{ readonly incidents: readonly Incident[] }>(this, `/api/incidents?${query}`)).incidents;
});

Then("they see the resolved incident", function (this: IncidentWorld) {
  assert.ok(this.incidentHistory.some((incident) => incident.id === this.resolvedIncidentId));
});

Then("they do not see the active incident", function (this: IncidentWorld) {
  assert.equal(this.incidentHistory.some((incident) => incident.id === this.activeIncidentId), false);
});

Given("there are incidents of different severities", async function (this: IncidentWorld) {
  await createAndResolvePaymentIncident(this);
  this.resolvedIncidentId = this.incidentId;
  await setPolicySeverity(this, "SEV-2");
  await createKafkaIncident(this);
  this.activeIncidentId = this.incidentId;
  const incidents = await getIncidents(this);
  assert.equal(incidents.find((incident) => incident.id === this.resolvedIncidentId)?.severity, "SEV-1");
  assert.equal(incidents.find((incident) => incident.id === this.activeIncidentId)?.severity, "SEV-2");
});

Then("they see only SEV-1 incidents", function (this: IncidentWorld) {
  assert.ok(this.incidentHistory.length > 0);
  assert.ok(this.incidentHistory.every((incident) => incident.severity === "SEV-1"));
});

Given("a {string} deployment incident has been resolved", async function (this: IncidentWorld, serviceId: string) {
  assert.equal(serviceId, "payment-service");
  await createPaymentIncident(this);
  await post(this, `/api/incidents/${incidentId(this)}/investigate`);
  const action = (await getIncident(this)).actions[0];
  assert.ok(action);
  await post(this, `/api/incidents/${incidentId(this)}/actions/${encodeURIComponent(action.id)}/approve`);
  advance(this, 6);
  await post(this, `/api/incidents/${incidentId(this)}/resolve`);
  this.resolvedIncidentId = this.incidentId;
});

When("the engineer opens that incident from Incident History", async function (this: IncidentWorld) {
  const page = await fetch(`${address(this)}/incidents.html`);
  assert.equal(page.status, 200);
  this.observedIncident = await getJson<Incident>(this, `/api/incidents/${encodeURIComponent(this.resolvedIncidentId ?? "")}`);
});

Then("they see its preserved timeline", function (this: IncidentWorld) {
  assert.ok((this.observedIncident?.timeline.length ?? 0) > 0);
});

Then("they see the deployment and alert evidence captured during the incident", async function (this: IncidentWorld) {
  const evidence = await getEvidenceFor(this, this.resolvedIncidentId);
  assert.ok(evidence.deployments.length > 0);
  assert.ok(evidence.alerts.length > 0);
});

Then("they see the incident-scoped metrics and logs", async function (this: IncidentWorld) {
  const evidence = await getEvidenceFor(this, this.resolvedIncidentId);
  assert.ok(evidence.metricHistories.length > 0);
  assert.ok(evidence.logs.length > 0);
});

Then("they see the final mitigation and resolution events", function (this: IncidentWorld) {
  assert.ok(this.observedIncident?.timeline.some((event) => event.type === "ACTION_COMPLETED"));
  assert.ok(this.observedIncident?.timeline.some((event) => event.type === "INCIDENT_RESOLVED"));
});

Given("no incidents have been created", function (this: IncidentWorld) {
  this.incidentHistory = [];
});

Then("they see an explanation that no incidents have been recorded", function (this: IncidentWorld) {
  assert.equal(this.incidentHistory.length, 0);
});

Then("they see a link to the simulator controls", async function (this: IncidentWorld) {
  const page = await fetch(`${address(this)}/incidents.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Simulator controls/);
});

async function createPaymentIncident(world: IncidentWorld): Promise<void> {
  await post(world, "/api/simulator/bad-payment-deployment");
  advance(world, 3);
  const incident = (await getIncidents(world)).find((candidate) => candidate.status !== "RESOLVED" && candidate.affectedServices.includes("payment-service"));
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

async function getEvidenceFor(world: IncidentWorld, targetIncidentId: string | undefined): Promise<IncidentEvidence & { readonly alerts: readonly unknown[]; readonly logs: readonly unknown[] }> {
  if (!targetIncidentId) throw new Error("Expected an incident identifier");
  return getJson<IncidentEvidence & { readonly alerts: readonly unknown[]; readonly logs: readonly unknown[] }>(world, `/api/incidents/${encodeURIComponent(targetIncidentId)}/evidence`);
}

async function createKafkaIncident(world: IncidentWorld): Promise<void> {
  await post(world, "/api/simulator/kafka-backlog");
  advance(world, 3);
  const incident = (await getIncidents(world)).find((candidate) => candidate.status !== "RESOLVED" && candidate.affectedServices.includes("kafka"));
  assert.ok(incident, "Expected a Kafka incident to be created");
  world.incidentId = incident.id;
}

async function createAndResolvePaymentIncident(world: IncidentWorld): Promise<void> {
  await createPaymentIncident(world);
  await post(world, "/api/simulator/recover");
  advance(world, 6);
  await post(world, `/api/incidents/${incidentId(world)}/resolve`);
}

async function setPolicySeverity(world: IncidentWorld, severity: "SEV-1" | "SEV-2"): Promise<void> {
  const policies = (await getJson<{ readonly policies: readonly { readonly id: string; readonly name: string; readonly metric: string; readonly comparator: string; readonly threshold: number; readonly breachDurationSeconds: number; readonly enabled: boolean; readonly scope: unknown }[] }>(world, "/api/alert-policies")).policies;
  for (const policy of policies) {
    const response = await fetch(`${address(world)}/api/alert-policies/${encodeURIComponent(policy.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...policy, severity }),
    });
    assert.equal(response.status, 200);
  }
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

async function postJson<T>(world: IncidentWorld, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${address(world)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Expected ${path} to succeed, received ${response.status}`);
  return await response.json() as T;
}

function address(world: IncidentWorld): string {
  if (!world.address) throw new Error("Acceptance test application is not listening");
  return world.address;
}

function actionId(world: IncidentWorld): string {
  if (!world.actionId) throw new Error("Acceptance scenario has no proposed action");
  return encodeURIComponent(world.actionId);
}
