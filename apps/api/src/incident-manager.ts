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
  | { readonly type: "log"; readonly timestamp: string; readonly serviceId: string; readonly message: string }
  | { readonly type: "system"; readonly system: ObservedSystem }
  | { readonly type: "telemetry" };
type Subscriber = (event: IncidentEvent) => void;

type IncidentManagerOptions = {
  readonly policies?: readonly MonitoringPolicy[];
  readonly correlationWindowMs?: number;
  readonly firstIncidentNumber?: number;
};

export class IncidentManager {
  private readonly subscribers = new Set<Subscriber>();
  private readonly alerts: Alert[] = [];
  private readonly evidence: IncidentTimelineEvent[] = [];
  private readonly activeAlertKeys = new Set<string>();
  private readonly activeAlerts = new Map<string, Alert>();
  private readonly breachStartedAt = new Map<string, string>();
  private policies: readonly MonitoringPolicy[];
  private readonly correlationWindowMs: number;
  private nextIncidentNumber: number;
  private incident: DetectedIncident | undefined;

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
      this.recordEvidence({ type: "DEPLOYMENT", timestamp: event.timestamp, serviceId: event.serviceId, message: event.message });
      return;
    }
    if (event.type === "log") {
      this.recordEvidence({ type: "LOG", timestamp: event.timestamp, serviceId: event.serviceId, message: event.message });
      return;
    }
    if (event.type !== "system" || this.incident) return;

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
      timeline: this.evidence.filter((event) => !event.serviceId || [...incidentServices].some((serviceId) => areConnected(system.services, event.serviceId ?? "", serviceId))),
    };
    this.publish({ type: "incident-created", incident: this.incident });
  }

  private recordEvidence(event: IncidentTimelineEvent): void {
    this.evidence.push(event);
    if (this.evidence.length > 30) this.evidence.shift();
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
