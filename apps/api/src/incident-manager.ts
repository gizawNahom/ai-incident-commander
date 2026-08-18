import {
  defaultAlertPolicies,
  policyAppliesToService,
  policyIsBreached,
  type AlertMetricName,
  type AlertPolicy,
} from "../../../packages/domain/src/alert-policy.ts";

export type MetricName = AlertMetricName;
export type MetricUnit = AlertPolicy["unit"];
export type MonitoringPolicy = AlertPolicy;

export type Alert = {
  readonly id: string;
  readonly policyId: string;
  readonly serviceId: string;
  readonly metric: MetricName;
  readonly severity: AlertPolicy["severity"];
  readonly title: string;
  readonly threshold: number;
  readonly observedValue: number;
  readonly unit: MetricUnit;
  readonly triggeredAt: string;
};

export type IncidentTimelineEvent = {
  readonly type: "DEPLOYMENT" | "LOG" | "ALERT_TRIGGERED" | "INCIDENT_CREATED" | "AI_ANALYSIS_STARTED" | "AI_HYPOTHESIS_GENERATED" | "ACTION_SUGGESTED";
  readonly timestamp: string;
  readonly message: string;
  readonly serviceId?: string;
};

export type DetectedIncident = {
  readonly id: string;
  readonly title: string;
  readonly severity: "SEV-1";
  readonly status: "DETECTED";
  readonly startedAt: string;
  readonly affectedServices: readonly string[];
  readonly alerts: readonly Alert[];
  readonly timeline: readonly IncidentTimelineEvent[];
};

export type IncidentMetricSample = Readonly<Record<MetricName, number>> & { readonly timestamp: string };
export type IncidentMetricHistory = { readonly serviceId: string; readonly samples: readonly IncidentMetricSample[] };
export type CapturedLog = { readonly timestamp: string; readonly serviceId: string; readonly level: "warn" | "error" | "info"; readonly message: string };
export type CapturedDeployment = { readonly timestamp: string; readonly serviceId: string; readonly message: string };
export type IncidentEvidence = {
  readonly capturedAt: string;
  readonly contextServiceIds: readonly string[];
  readonly topology: readonly ObservedService[];
  readonly metricHistories: readonly IncidentMetricHistory[];
  readonly logs: readonly CapturedLog[];
  readonly deployments: readonly CapturedDeployment[];
  readonly alerts: readonly Alert[];
};

export type IncidentEvent =
  | { readonly type: "alert-triggered"; readonly alert: Alert }
  | { readonly type: "incident-created"; readonly incident: DetectedIncident }
  | { readonly type: "incident-updated"; readonly incident: DetectedIncident };

export type DetectionStatus = {
  readonly state: "NO_ACTIVE_ALERTS" | "WAITING_FOR_CORRELATED_EVIDENCE" | "INCIDENT_CREATED";
  readonly message: string;
  readonly activeAlerts: readonly Alert[];
};

type ObservedService = {
  readonly id: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly metrics: Readonly<Record<MetricName, number>>;
};

type ObservedSystem = { readonly timestamp: string; readonly services: readonly ObservedService[] };
type OperationalEvent =
  | { readonly type: "deployment"; readonly timestamp: string; readonly serviceId: string; readonly message: string }
  | { readonly type: "log"; readonly timestamp: string; readonly serviceId: string; readonly level?: "warn" | "error" | "info"; readonly message: string }
  | { readonly type: "system"; readonly system: ObservedSystem }
  | { readonly type: "telemetry" };
type Subscriber = (event: IncidentEvent) => void;

const MAX_PRE_INCIDENT_SAMPLES = 30;
const MAX_INCIDENT_SAMPLES = 240;
const PRESERVED_OPENING_SAMPLES = 60;
const MAX_CAPTURED_LOGS = 250;
const PRESERVED_OPENING_LOGS = 100;
const MAX_CONTEXT_SERVICES = 12;

type IncidentManagerOptions = {
  readonly policies?: readonly MonitoringPolicy[];
  readonly correlationWindowMs?: number;
  readonly firstIncidentNumber?: number;
};

export class IncidentManager {
  private readonly subscribers = new Set<Subscriber>();
  private readonly alerts: Alert[] = [];
  private readonly timelineEvidence: IncidentTimelineEvent[] = [];
  private readonly recentMetricHistory = new Map<string, IncidentMetricSample[]>();
  private readonly recentLogs: CapturedLog[] = [];
  private readonly activeAlertKeys = new Set<string>();
  private readonly activeAlerts = new Map<string, Alert>();
  private readonly breachStartedAt = new Map<string, string>();
  private policies: readonly MonitoringPolicy[];
  private readonly correlationWindowMs: number;
  private nextIncidentNumber: number;
  private incident: DetectedIncident | undefined;
  private incidentEvidence: IncidentEvidence | undefined;

  constructor(options: IncidentManagerOptions = {}) {
    this.policies = options.policies ?? defaultAlertPolicies;
    this.correlationWindowMs = options.correlationWindowMs ?? 60_000;
    this.nextIncidentNumber = options.firstIncidentNumber ?? 1042;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  list(): readonly DetectedIncident[] {
    return this.incident ? [this.incident] : [];
  }

  find(id: string): DetectedIncident | undefined {
    return this.incident?.id === id ? this.incident : undefined;
  }

  evidenceFor(id: string): IncidentEvidence | undefined {
    return this.incident?.id === id ? this.incidentEvidence : undefined;
  }

  setPolicies(policies: readonly MonitoringPolicy[]): void {
    this.policies = policies;
    this.activeAlertKeys.clear();
    this.activeAlerts.clear();
    this.breachStartedAt.clear();
  }

  detectionStatus(): DetectionStatus {
    const activeAlerts = [...this.activeAlerts.values()];
    if (this.incident) {
      return {
        state: "INCIDENT_CREATED",
        message: "Correlated alerts created an incident.",
        activeAlerts,
      };
    }
    if (activeAlerts.length === 0) {
      return {
        state: "NO_ACTIVE_ALERTS",
        message: "No active alert conditions are waiting for correlation.",
        activeAlerts,
      };
    }
    return {
      state: "WAITING_FOR_CORRELATED_EVIDENCE",
      message: "Active alerts are waiting for a correlated alert from a distinct detection policy on a connected service.",
      activeAlerts,
    };
  }

  recordInvestigation(input: { readonly incidentId: string; readonly timestamp: string; readonly hypothesis: string; readonly suggestedAction?: string }): void {
    if (!this.incident || this.incident.id !== input.incidentId) return;
    const timeline: IncidentTimelineEvent[] = [
      ...this.incident.timeline,
      { type: "AI_ANALYSIS_STARTED", timestamp: input.timestamp, message: "Offline investigator analysis started" },
      { type: "AI_HYPOTHESIS_GENERATED", timestamp: input.timestamp, message: input.hypothesis },
      ...(input.suggestedAction ? [{ type: "ACTION_SUGGESTED" as const, timestamp: input.timestamp, message: input.suggestedAction }] : []),
    ];
    this.incident = { ...this.incident, timeline };
    this.publish({ type: "incident-updated", incident: this.incident });
  }

  observe(event: OperationalEvent): void {
    if (event.type === "deployment") {
      const timelineEvent = { type: "DEPLOYMENT" as const, timestamp: event.timestamp, serviceId: event.serviceId, message: event.message };
      this.recordEvidence(timelineEvent);
      this.captureDeployment(timelineEvent);
      return;
    }
    if (event.type === "log") {
      const timelineEvent = { type: "LOG" as const, timestamp: event.timestamp, serviceId: event.serviceId, message: event.message };
      this.recordEvidence(timelineEvent);
      const log: CapturedLog = { timestamp: event.timestamp, serviceId: event.serviceId, level: event.level ?? "info", message: event.message };
      pushBounded(this.recentLogs, log, MAX_CAPTURED_LOGS, PRESERVED_OPENING_LOGS);
      this.captureLog(timelineEvent, log);
      return;
    }
    if (event.type !== "system") return;

    this.recordRecentMetrics(event.system);
    if (this.incident) {
      this.captureMetrics(event.system);
      return;
    }

    for (const service of event.system.services) {
      for (const policy of this.policies) {
        const observedValue = service.metrics[policy.metric];
        this.evaluatePolicy(service, policy, observedValue, event.system.timestamp);
      }
    }
    const pair = this.findCorrelatedPair(event.system);
    if (pair) this.createIncident(event.system, pair);
  }

  private evaluatePolicy(service: ObservedService, policy: MonitoringPolicy, observedValue: number, timestamp: string): void {
    const key = `${policy.id}:${service.id}`;
    if (!policy.enabled || !policyAppliesToService(policy, service.id) || !policyIsBreached(policy, observedValue)) {
      this.breachStartedAt.delete(key);
      this.activeAlertKeys.delete(key);
      this.activeAlerts.delete(key);
      return;
    }
    const breachStartedAt = this.breachStartedAt.get(key) ?? timestamp;
    this.breachStartedAt.set(key, breachStartedAt);
    const breachDurationMs = policy.breachDurationSeconds * 1_000;
    if (elapsedMs(timestamp, breachStartedAt) >= breachDurationMs) this.triggerAlert(service, policy, observedValue, timestamp);
  }

  private triggerAlert(service: ObservedService, policy: MonitoringPolicy, observedValue: number, timestamp: string): void {
    const key = `${policy.id}:${service.id}`;
    if (this.activeAlertKeys.has(key)) return;
    this.activeAlertKeys.add(key);
    const alert: Alert = {
      id: `ALR-${this.alerts.length + 1}`,
      policyId: policy.id,
      serviceId: service.id,
      metric: policy.metric,
      severity: policy.severity,
      title: `${service.name} ${policy.name}`,
      threshold: policy.threshold,
      observedValue,
      unit: policy.unit,
      triggeredAt: timestamp,
    };
    this.alerts.push(alert);
    this.activeAlerts.set(key, alert);
    this.recordEvidence({ type: "ALERT_TRIGGERED", timestamp, serviceId: service.id, message: `${alert.title} (observed ${alert.observedValue}${alert.unit})` });
    this.publish({ type: "alert-triggered", alert });
  }

  private findCorrelatedPair(system: ObservedSystem): readonly [Alert, Alert] | undefined {
    const recentAlerts = this.alerts.filter((alert) => elapsedMs(system.timestamp, alert.triggeredAt) <= this.correlationWindowMs);
    for (let first = 0; first < recentAlerts.length; first += 1) {
      for (let second = first + 1; second < recentAlerts.length; second += 1) {
        const left = recentAlerts[first];
        const right = recentAlerts[second];
        if (left.policyId !== right.policyId && areConnected(system.services, left.serviceId, right.serviceId)) return [left, right];
      }
    }
    return undefined;
  }

  private createIncident(system: ObservedSystem, pair: readonly [Alert, Alert]): void {
    const incidentId = `INC-${this.nextIncidentNumber}`;
    this.nextIncidentNumber += 1;
    const alertServices = [...new Set(pair.map((alert) => alert.serviceId))].sort();
    const serviceById = new Map(system.services.map((service) => [service.id, service]));
    const impactAlert = pair.find((alert) => alert.metric === "errorRate") ?? pair[0];
    const title = `${serviceById.get(impactAlert.serviceId)?.name ?? impactAlert.serviceId} degradation`;
    const creation: IncidentTimelineEvent = {
      type: "INCIDENT_CREATED",
      timestamp: system.timestamp,
      message: `${incidentId} created from ${pair.length} correlated alerts`,
    };
    this.recordEvidence(creation);
    const incidentServices = new Set(alertServices);
    this.incident = {
      id: incidentId,
      title,
      severity: "SEV-1",
      status: "DETECTED",
      startedAt: system.timestamp,
      affectedServices: alertServices,
      alerts: [...pair],
      timeline: this.timelineEvidence.filter((event) => !event.serviceId || [...incidentServices].some((serviceId) => areConnected(system.services, event.serviceId ?? "", serviceId))),
    };
    this.incidentEvidence = this.createEvidence(system, pair, incidentServices);
    this.publish({ type: "incident-created", incident: this.incident });
  }

  private recordEvidence(event: IncidentTimelineEvent): void {
    this.timelineEvidence.push(event);
    if (this.timelineEvidence.length > 30) this.timelineEvidence.shift();
  }

  private recordRecentMetrics(system: ObservedSystem): void {
    for (const service of system.services) {
      const samples = this.recentMetricHistory.get(service.id) ?? [];
      pushBounded(samples, { timestamp: system.timestamp, ...service.metrics }, MAX_PRE_INCIDENT_SAMPLES, 0);
      this.recentMetricHistory.set(service.id, samples);
    }
  }

  private createEvidence(system: ObservedSystem, alerts: readonly Alert[], incidentServices: ReadonlySet<string>): IncidentEvidence {
    const topology = contextTopology(system.services, incidentServices);
    const contextServiceIds = topology.map((service) => service.id);
    return {
      capturedAt: system.timestamp,
      contextServiceIds,
      topology,
      metricHistories: topology.map((service) => ({ serviceId: service.id, samples: [...(this.recentMetricHistory.get(service.id) ?? [])] })),
      logs: this.recentLogs.filter((log) => contextServiceIds.includes(log.serviceId)),
      deployments: this.timelineEvidence
        .filter((event) => event.type === "DEPLOYMENT" && event.serviceId && contextServiceIds.includes(event.serviceId))
        .map((event) => ({ timestamp: event.timestamp, serviceId: event.serviceId ?? "", message: event.message })),
      alerts: [...alerts],
    };
  }

  private captureMetrics(system: ObservedSystem): void {
    if (!this.incidentEvidence) return;
    const histories = new Map(this.incidentEvidence.metricHistories.map((history) => [history.serviceId, [...history.samples]]));
    for (const service of system.services) {
      const samples = histories.get(service.id);
      if (!samples) continue;
      pushBounded(samples, { timestamp: system.timestamp, ...service.metrics }, MAX_INCIDENT_SAMPLES, PRESERVED_OPENING_SAMPLES);
      histories.set(service.id, samples);
    }
    this.incidentEvidence = { ...this.incidentEvidence, metricHistories: [...histories].map(([serviceId, samples]) => ({ serviceId, samples })) };
  }

  private captureLog(timelineEvent: IncidentTimelineEvent, log: CapturedLog): void {
    if (!this.incidentEvidence || !this.incidentEvidence.contextServiceIds.includes(log.serviceId)) return;
    const logs = [...this.incidentEvidence.logs];
    pushBounded(logs, log, MAX_CAPTURED_LOGS, PRESERVED_OPENING_LOGS);
    this.incidentEvidence = { ...this.incidentEvidence, logs };
    this.appendIncidentTimeline(timelineEvent);
  }

  private captureDeployment(timelineEvent: IncidentTimelineEvent): void {
    if (!this.incidentEvidence || !timelineEvent.serviceId || !this.incidentEvidence.contextServiceIds.includes(timelineEvent.serviceId)) return;
    this.incidentEvidence = {
      ...this.incidentEvidence,
      deployments: [...this.incidentEvidence.deployments, { timestamp: timelineEvent.timestamp, serviceId: timelineEvent.serviceId, message: timelineEvent.message }],
    };
    this.appendIncidentTimeline(timelineEvent);
  }

  private appendIncidentTimeline(event: IncidentTimelineEvent): void {
    if (!this.incident) return;
    this.incident = { ...this.incident, timeline: [...this.incident.timeline, event] };
    this.publish({ type: "incident-updated", incident: this.incident });
  }

  private publish(event: IncidentEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

function elapsedMs(laterTimestamp: string, earlierTimestamp: string): number {
  return Math.max(0, Date.parse(laterTimestamp) - Date.parse(earlierTimestamp));
}

function areConnected(services: readonly ObservedService[], from: string, to: string): boolean {
  if (from === to) return true;
  const graph = new Map<string, Set<string>>();
  for (const service of services) {
    if (!graph.has(service.id)) graph.set(service.id, new Set());
    for (const dependency of service.dependencies) {
      if (!graph.has(dependency)) graph.set(dependency, new Set());
      graph.get(service.id)?.add(dependency);
      graph.get(dependency)?.add(service.id);
    }
  }
  const visited = new Set([from]);
  const pending = [from];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === to) return true;
    for (const adjacent of graph.get(current) ?? []) {
      if (!visited.has(adjacent)) {
        visited.add(adjacent);
        pending.push(adjacent);
      }
    }
  }
  return false;
}

function contextTopology(services: readonly ObservedService[], incidentServices: ReadonlySet<string>): readonly ObservedService[] {
  const contextIds = new Set(incidentServices);
  for (const service of services) {
    if (incidentServices.has(service.id) || service.dependencies.some((dependency) => incidentServices.has(dependency))) {
      contextIds.add(service.id);
      for (const dependency of service.dependencies) contextIds.add(dependency);
    }
  }
  const roots = services.filter((service) => incidentServices.has(service.id));
  const neighbors = services.filter((service) => !incidentServices.has(service.id) && contextIds.has(service.id));
  return [...roots, ...neighbors].slice(0, MAX_CONTEXT_SERVICES);
}

function pushBounded<T>(items: T[], item: T, maximum: number, preservedOpeningItems: number): void {
  if (items.length >= maximum) items.splice(Math.min(preservedOpeningItems, items.length - 1), 1);
  items.push(item);
}
