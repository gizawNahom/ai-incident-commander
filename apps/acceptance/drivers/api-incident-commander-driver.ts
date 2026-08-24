import assert from "node:assert/strict";

import { createServer } from "../../api/src/server.ts";

import type { IncidentCommanderDriver } from "./incident-commander-driver.ts";

type Application = ReturnType<typeof createServer>;
type Incident = {
  readonly id: string;
  readonly status: "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED";
  readonly affectedServices: readonly string[];
  readonly timeline: readonly { readonly type: string; readonly message: string }[];
  readonly actions: readonly { readonly id: string; readonly status: string; readonly targetServiceId: string; readonly toVersion: string }[];
};
type System = { readonly services: readonly { readonly id: string; readonly health: string; readonly version: string }[] };
type ServiceDetail = {
  readonly service: { readonly id: string; readonly health: string };
  readonly logs: readonly { readonly message: string }[];
  readonly dependencies: readonly unknown[];
  readonly activeAlerts: readonly unknown[];
  readonly relatedIncidents: readonly Incident[];
};
type Evidence = {
  readonly deployments: readonly { readonly message: string }[];
  readonly logs: readonly { readonly message: string }[];
  readonly metricHistories: readonly { readonly samples: readonly { readonly latencyMs?: number }[] }[];
};

export class ApiIncidentCommanderDriver implements IncidentCommanderDriver {
  private app: Application | undefined;
  private address: string | undefined;
  private incident: Incident | undefined;
  private actionId: string | undefined;

  async start(): Promise<void> {
    this.app = createServer({ autoStart: false });
    this.address = await this.app.listen();
  }

  async stop(): Promise<void> {
    await this.app?.close();
  }

  async openHealthyCommandCenter(): Promise<void> {
    const system = await this.get<System>("/api/system");
    assert.ok(system.services.every((service) => service.health === "healthy"));
  }

  async deployDefectivePaymentVersion(): Promise<void> {
    await this.post("/api/simulator/bad-payment-deployment");
    this.advance(3);
  }

  async assertCheckoutDegradationIncident(): Promise<void> {
    const incidents = await this.incidents();
    const incident = incidents.find((candidate) => candidate.status !== "RESOLVED" && candidate.affectedServices.includes("checkout-service"));
    assert.ok(incident, "Expected a checkout degradation incident");
    this.incident = incident;
  }

  async openPaymentService(): Promise<void> {
    const detail = await this.get<ServiceDetail>("/api/services/payment-service");
    assert.equal(detail.service.id, "payment-service");
  }

  async assertPaymentServiceContext(): Promise<void> {
    const detail = await this.get<ServiceDetail>("/api/services/payment-service");
    assert.equal(detail.service.health, "critical");
    assert.ok(detail.activeAlerts.length > 0);
    assert.ok(detail.logs.length > 0);
    assert.ok(detail.dependencies.length > 0);
    assert.ok(detail.relatedIncidents.some((candidate) => candidate.id === this.incidentId()));
  }

  async openRelatedIncidentRoom(): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/incident.html?id=${encodeURIComponent(this.incidentId())}`);
    assert.equal(response.status, 200);
  }

  async analyzeIncident(): Promise<void> {
    await this.post(`/api/incidents/${encodeURIComponent(this.incidentId())}/investigate`);
    this.incident = await this.get<Incident>(`/api/incidents/${encodeURIComponent(this.incidentId())}`);
    const action = this.incident.actions.find((candidate) => candidate.targetServiceId === "payment-service");
    assert.ok(action, "Expected the investigator to propose a payment rollback");
    this.actionId = action.id;
  }

  async assertGroundedDeploymentEvidence(): Promise<void> {
    const evidence = await this.evidence();
    assert.ok(evidence.deployments.some((deployment) => deployment.message.includes("payment-service v1.8.3 deployment completed")));
  }

  async assertRollbackProposedWithoutSystemChange(): Promise<void> {
    const system = await this.get<System>("/api/system");
    assert.equal(system.services.find((service) => service.id === "payment-service")?.version, "v1.8.3");
    assert.equal(this.incident?.actions.find((action) => action.id === this.actionId)?.status, "PROPOSED");
  }

  async approveRollback(): Promise<void> {
    this.incident = await this.post<Incident>(`/api/incidents/${encodeURIComponent(this.incidentId())}/actions/${encodeURIComponent(this.actionIdValue())}/approve`);
  }

  async assertPaymentReturnsToStableVersion(): Promise<void> {
    const system = await this.get<System>("/api/system");
    assert.equal(system.services.find((service) => service.id === "payment-service")?.version, "v1.8.2");
  }

  async assertIncidentMonitoringRecovery(): Promise<void> {
    this.advance(6);
    this.incident = await this.get<Incident>(`/api/incidents/${encodeURIComponent(this.incidentId())}`);
    assert.equal(this.incident.status, "MONITORING");
  }

  async resolveMonitoredIncident(): Promise<void> {
    this.incident = await this.post<Incident>(`/api/incidents/${encodeURIComponent(this.incidentId())}/resolve`);
    assert.equal(this.incident.status, "RESOLVED");
  }

  async openIncidentHistory(): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/incidents.html`);
    assert.equal(response.status, 200);
  }

  async assertResolvedIncidentListed(): Promise<void> {
    const incident = (await this.incidents()).find((candidate) => candidate.id === this.incidentId());
    assert.equal(incident?.status, "RESOLVED");
  }

  async reopenResolvedIncidentRoom(): Promise<void> {
    await this.openRelatedIncidentRoom();
  }

  async assertPreservedIncidentRecord(): Promise<void> {
    const incident = await this.get<Incident>(`/api/incidents/${encodeURIComponent(this.incidentId())}`);
    const evidence = await this.evidence();
    assert.ok(evidence.deployments.some((deployment) => deployment.message.includes("payment-service v1.8.3 deployment completed")));
    assert.ok(evidence.metricHistories.some((history) => history.samples.some((sample) => (sample.latencyMs ?? 0) > 1_000)));
    assert.ok(evidence.logs.some((log) => log.message.includes("connection pool timeout")));
    assert.ok(incident.timeline.some((event) => event.type === "ACTION_COMPLETED"));
    assert.ok(incident.timeline.some((event) => event.type === "INCIDENT_RESOLVED"));
  }

  private advance(count: number): void {
    if (!this.app) throw new Error("Acceptance test application is not running");
    for (let tick = 0; tick < count; tick += 1) this.app.advance();
  }

  private async incidents(): Promise<readonly Incident[]> {
    return (await this.get<{ readonly incidents: readonly Incident[] }>("/api/incidents")).incidents;
  }

  private async evidence(): Promise<Evidence> {
    return this.get<Evidence>(`/api/incidents/${encodeURIComponent(this.incidentId())}/evidence`);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`);
    if (!response.ok) throw new Error(`Expected ${path} to succeed, received ${response.status}`);
    return await response.json() as T;
  }

  private async post<T = void>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`, { method: "POST" });
    if (!response.ok) throw new Error(`Expected ${path} to succeed, received ${response.status}`);
    return await response.json() as T;
  }

  private baseUrl(): string {
    if (!this.address) throw new Error("Acceptance test application is not listening");
    return this.address;
  }

  private incidentId(): string {
    if (!this.incident) throw new Error("The shared journey has no incident");
    return this.incident.id;
  }

  private actionIdValue(): string {
    if (!this.actionId) throw new Error("The shared journey has no rollback action");
    return this.actionId;
  }
}
