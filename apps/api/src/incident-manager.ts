import {
  defaultAlertPolicies,
  policyAppliesToService,
  policyIsBreached,
  type AlertMetricName,
  type AlertPolicy,
} from "../../../packages/domain/src/alert-policy.ts";
import {
  ActionTransitionError,
  approveSuggestedAction,
  beginSuggestedActionExecution,
  completeSuggestedAction,
  failSuggestedAction,
  proposeRollback,
  rejectSuggestedAction,
  type ActionRisk,
  type SuggestedAction,
} from "../../../packages/domain/src/suggested-action.ts";
import {
  assignIncidentCommander,
  IncidentCommandError,
  requireIncidentCommander,
  type IncidentActor,
  type IncidentCommander,
} from "../../../packages/domain/src/incident-command.ts";

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
  readonly type: "DEPLOYMENT" | "LOG" | "ALERT_TRIGGERED" | "INCIDENT_CREATED" | "INCIDENT_COMMAND_ASSIGNED" | "INCIDENT_COMMAND_TRANSFERRED" | "AI_ANALYSIS_STARTED" | "AI_HYPOTHESIS_GENERATED" | "ACTION_SUGGESTED" | "ACTION_APPROVED" | "ACTION_REJECTED" | "ACTION_EXECUTED" | "ACTION_COMPLETED" | "ACTION_FAILED" | "RECOVERY_MONITORING" | "INCIDENT_REOPENED" | "INCIDENT_RESOLVED";
  readonly timestamp: string;
  readonly message: string;
  readonly serviceId?: string;
  readonly version?: string;
  readonly previousVersion?: string;
  readonly deploymentKind?: "RELEASE" | "ROLLBACK";
};

export type DetectedIncident = {
  readonly id: string;
  readonly title: string;
  readonly severity: AlertPolicy["severity"];
  readonly status: "DETECTED" | "INVESTIGATING" | "MONITORING" | "RESOLVED";
  readonly startedAt: string;
  readonly resolvedAt?: string;
  readonly affectedServices: readonly string[];
  readonly alerts: readonly Alert[];
  readonly timeline: readonly IncidentTimelineEvent[];
  readonly actions: readonly SuggestedAction[];
  readonly commander?: IncidentCommander;
};

export type SuggestedActionRecommendation = {
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly targetServiceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reasoning: string;
  readonly evidenceIds: readonly string[];
  readonly risk: ActionRisk;
};

export type IncidentMetricSample = Readonly<Partial<Record<MetricName, number>>> & { readonly timestamp: string };
export type IncidentMetricHistory = { readonly serviceId: string; readonly samples: readonly IncidentMetricSample[] };
export type CapturedLog = { readonly timestamp: string; readonly serviceId: string; readonly level: "warn" | "error" | "info"; readonly message: string };
export type CapturedDeployment = { readonly timestamp: string; readonly serviceId: string; readonly message: string; readonly version?: string; readonly previousVersion?: string; readonly deploymentKind?: "RELEASE" | "ROLLBACK" };
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

export class IncidentResolutionError extends Error {}
export class IncidentActionError extends Error {}
export class IncidentCommandAssignmentError extends Error {}

type ObservedService = {
  readonly id: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly metrics: Readonly<Partial<Record<MetricName, number>>>;
};

type ObservedSystem = { readonly timestamp: string; readonly services: readonly ObservedService[] };
type OperationalEvent =
  | { readonly type: "deployment"; readonly timestamp: string; readonly serviceId: string; readonly version?: string; readonly previousVersion?: string; readonly deploymentKind?: "RELEASE" | "ROLLBACK"; readonly message: string }
  | { readonly type: "log"; readonly timestamp: string; readonly serviceId: string; readonly level?: "warn" | "error" | "info"; readonly message: string }
  | { readonly type: "system"; readonly system: ObservedSystem }
  | { readonly type: "telemetry" };
type Subscriber = (event: IncidentEvent) => void;

type IncidentRecord = {
  readonly correlationKey: string;
  readonly evidence: IncidentEvidence;
  readonly healthyObservations: number;
  readonly incident: DetectedIncident;
};

const MAX_PRE_INCIDENT_SAMPLES = 30;
const MAX_INCIDENT_SAMPLES = 240;
const PRESERVED_OPENING_SAMPLES = 60;
const MAX_CAPTURED_LOGS = 250;
const PRESERVED_OPENING_LOGS = 100;
const MAX_CONTEXT_SERVICES = 12;
const RECOVERY_OBSERVATIONS_REQUIRED = 3;

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
  private nextActionNumber = 1;
  private readonly records = new Map<string, IncidentRecord>();

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
    return [...this.records.values()].map((record) => record.incident);
  }

  find(id: string): DetectedIncident | undefined {
    return this.records.get(id)?.incident;
  }

  evidenceFor(id: string): IncidentEvidence | undefined {
    return this.records.get(id)?.evidence;
  }

  setPolicies(policies: readonly MonitoringPolicy[]): void {
    this.policies = policies;
    this.activeAlertKeys.clear();
    this.activeAlerts.clear();
    this.breachStartedAt.clear();
  }

  detectionStatus(): DetectionStatus {
    const activeAlerts = [...this.activeAlerts.values()];
    if ([...this.records.values()].some((record) => record.incident.status !== "RESOLVED")) {
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

  activeAlertsFor(serviceId: string): readonly Alert[] {
    return [...this.activeAlerts.values()].filter((alert) => alert.serviceId === serviceId);
  }

  recordInvestigation(input: { readonly incidentId: string; readonly timestamp: string; readonly hypothesis: string; readonly suggestedAction?: string | SuggestedActionRecommendation }): void {
    const record = this.records.get(input.incidentId);
    if (!record || record.incident.status === "RESOLVED") return;
    const action = typeof input.suggestedAction === "string" || !input.suggestedAction
      ? undefined
      : this.proposeAction(record.incident, input.suggestedAction, input.timestamp);
    const timeline: IncidentTimelineEvent[] = [
      ...record.incident.timeline,
      { type: "AI_ANALYSIS_STARTED", timestamp: input.timestamp, message: "Offline investigator analysis started" },
      { type: "AI_HYPOTHESIS_GENERATED", timestamp: input.timestamp, message: input.hypothesis },
      ...(typeof input.suggestedAction === "string" ? [{ type: "ACTION_SUGGESTED" as const, timestamp: input.timestamp, message: input.suggestedAction }] : []),
      ...(action ? [{ type: "ACTION_SUGGESTED" as const, timestamp: input.timestamp, message: `Rollback ${action.targetServiceId} from ${action.fromVersion} to ${action.toVersion} proposed` }] : []),
    ];
    this.updateRecord(input.incidentId, { ...record, incident: { ...record.incident, timeline, actions: action ? [...record.incident.actions, action] : record.incident.actions } });
  }

  takeCommand(incidentId: string, timestamp: string, actor: IncidentActor, takeoverReason?: string): DetectedIncident {
    const record = this.records.get(incidentId);
    if (!record) throw new IncidentCommandAssignmentError("Incident not found");
    if (record.incident.status === "RESOLVED") throw new IncidentCommandAssignmentError("A resolved incident cannot accept an Incident Commander");
    try {
      if (record.incident.commander && record.incident.commander.id !== actor.id) {
        if (!takeoverReason || takeoverReason.trim().length === 0) throw new IncidentCommandAssignmentError("A takeover reason is required to replace the current Incident Commander");
        const previousCommander = record.incident.commander;
        const commander: IncidentCommander = { ...actor, assignedAt: timestamp };
        const incident: DetectedIncident = {
          ...record.incident,
          commander,
          timeline: [...record.incident.timeline, {
            type: "INCIDENT_COMMAND_TRANSFERRED",
            timestamp,
            message: `${commander.name} took incident command from ${previousCommander.name}: ${takeoverReason.trim()}`,
          }],
        };
        this.updateRecord(incidentId, { ...record, incident });
        return incident;
      }
      const commander = assignIncidentCommander(record.incident.commander, actor, timestamp);
      const incident: DetectedIncident = {
        ...record.incident,
        commander,
        timeline: record.incident.commander
          ? record.incident.timeline
          : [...record.incident.timeline, { type: "INCIDENT_COMMAND_ASSIGNED", timestamp, message: `${commander.name} took incident command` }],
      };
      this.updateRecord(incidentId, { ...record, incident });
      return incident;
    } catch (error) {
      if (error instanceof IncidentCommandError) throw new IncidentCommandAssignmentError(error.message);
      throw error;
    }
  }

  approveAction(incidentId: string, actionId: string, timestamp: string, actor: IncidentActor): SuggestedAction {
    const { record, action } = this.actionRecord(incidentId, actionId);
    try {
      requireIncidentCommander(record.incident.commander, actor);
      const approved = approveSuggestedAction(action, timestamp, actor.name);
      this.updateAction(record, approved, { type: "ACTION_APPROVED", timestamp, message: `${actor.name} approved rollback of ${approved.targetServiceId} from ${approved.fromVersion} to ${approved.toVersion}` });
      return approved;
    } catch (error) {
      throw actionError(error);
    }
  }

  rejectAction(incidentId: string, actionId: string, timestamp: string, actor: IncidentActor, reason: string): SuggestedAction {
    const { record, action } = this.actionRecord(incidentId, actionId);
    try {
      const rejected = rejectSuggestedAction(action, timestamp, actor.name, reason);
      this.updateAction(record, rejected, { type: "ACTION_REJECTED", timestamp, message: `${actor.name} rejected rollback of ${rejected.targetServiceId}: ${reason}` });
      return rejected;
    } catch (error) {
      throw actionError(error);
    }
  }

  beginActionExecution(incidentId: string, actionId: string, timestamp: string): SuggestedAction {
    const { record, action } = this.actionRecord(incidentId, actionId);
    try {
      const executing = beginSuggestedActionExecution(action, timestamp);
      this.updateAction(record, executing, { type: "ACTION_EXECUTED", timestamp, message: `Rollback execution started for ${executing.targetServiceId}` });
      return executing;
    } catch (error) {
      throw actionError(error);
    }
  }

  completeAction(incidentId: string, actionId: string, timestamp: string, outcome: string): SuggestedAction {
    const { record, action } = this.actionRecord(incidentId, actionId);
    try {
      const completed = completeSuggestedAction(action, timestamp, outcome);
      this.updateAction(record, completed, { type: "ACTION_COMPLETED", timestamp, message: `Rollback completed for ${completed.targetServiceId}: ${outcome}` });
      return completed;
    } catch (error) {
      throw actionError(error);
    }
  }

  failAction(incidentId: string, actionId: string, timestamp: string, outcome: string): SuggestedAction {
    const { record, action } = this.actionRecord(incidentId, actionId);
    try {
      const failed = failSuggestedAction(action, timestamp, outcome);
      this.updateAction(record, failed, { type: "ACTION_FAILED", timestamp, message: `Rollback failed for ${failed.targetServiceId}: ${outcome}` });
      return failed;
    } catch (error) {
      throw actionError(error);
    }
  }

  resolve(incidentId: string, timestamp: string, actor: IncidentActor): DetectedIncident {
    const record = this.records.get(incidentId);
    if (!record) throw new IncidentResolutionError("Incident not found");
    if (record.incident.status !== "MONITORING") throw new IncidentResolutionError("Only an incident in monitoring can be resolved");
    try {
      requireIncidentCommander(record.incident.commander, actor);
    } catch (error) {
      throw new IncidentResolutionError(error instanceof Error ? error.message : "Incident command is required");
    }
    const incident: DetectedIncident = {
      ...record.incident,
      status: "RESOLVED",
      resolvedAt: timestamp,
      timeline: [...record.incident.timeline, {
        type: "INCIDENT_RESOLVED",
        timestamp,
        message: `${actor.name} resolved this incident after recovery monitoring`,
      }],
    };
    this.updateRecord(incidentId, { ...record, incident });
    return incident;
  }

  observe(event: OperationalEvent): void {
    if (event.type === "deployment") {
      const timelineEvent = { type: "DEPLOYMENT" as const, timestamp: event.timestamp, serviceId: event.serviceId, version: event.version, previousVersion: event.previousVersion, deploymentKind: event.deploymentKind, message: event.message };
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
    for (const service of event.system.services) {
      for (const policy of this.policies) {
        const observedValue = service.metrics[policy.metric];
        this.evaluatePolicy(service, policy, observedValue, event.system.timestamp);
      }
    }
    this.captureMetrics(event.system);
    for (const pair of this.findCorrelatedPairs(event.system)) this.handleCorrelatedPair(event.system, pair);
    this.observeRecovery(event.system);
  }

  private evaluatePolicy(service: ObservedService, policy: MonitoringPolicy, observedValue: number | undefined, timestamp: string): void {
    const key = `${policy.id}:${service.id}`;
    if (typeof observedValue !== "number" || !Number.isFinite(observedValue) || !policy.enabled || !policyAppliesToService(policy, service.id) || !policyIsBreached(policy, observedValue)) {
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

  private findCorrelatedPairs(system: ObservedSystem): readonly (readonly [Alert, Alert])[] {
    const pairs: (readonly [Alert, Alert])[] = [];
    const recentAlerts = [...this.activeAlerts.values()].filter((alert) => elapsedMs(system.timestamp, alert.triggeredAt) <= this.correlationWindowMs);
    for (let first = 0; first < recentAlerts.length; first += 1) {
      for (let second = first + 1; second < recentAlerts.length; second += 1) {
        const left = recentAlerts[first];
        const right = recentAlerts[second];
        if (left.policyId !== right.policyId && areConnected(system.services, left.serviceId, right.serviceId)) pairs.push([left, right]);
      }
    }
    return pairs;
  }

  private handleCorrelatedPair(system: ObservedSystem, pair: readonly [Alert, Alert]): void {
    const correlationKey = pairCorrelationKey(pair);
    const pairAlertKeys = new Set(pair.map(alertKey));
    const matching = [...this.records.values()].find((record) => record.incident.status !== "RESOLVED" && (
      record.correlationKey === correlationKey || record.incident.alerts.some((alert) => pairAlertKeys.has(alertKey(alert)))
    ));
    if (!matching) {
      this.createIncident(system, pair, correlationKey);
      return;
    }
    if (matching.incident.status === "MONITORING") {
      const incident: DetectedIncident = {
        ...matching.incident,
        status: "INVESTIGATING",
        timeline: [...matching.incident.timeline, {
          type: "INCIDENT_REOPENED",
          timestamp: system.timestamp,
          message: "Related alert conditions returned during recovery monitoring",
        }],
      };
      this.updateRecord(incident.id, { ...matching, healthyObservations: 0, incident });
    }
  }

  private createIncident(system: ObservedSystem, pair: readonly [Alert, Alert], correlationKey: string): void {
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
    const incident: DetectedIncident = {
      id: incidentId,
      title,
      severity: highestSeverity(pair),
      status: "DETECTED",
      startedAt: system.timestamp,
      affectedServices: alertServices,
      alerts: [...pair],
      timeline: [
        ...this.timelineEvidence.filter((event) => event.type !== "INCIDENT_CREATED" && (!event.serviceId || [...incidentServices].some((serviceId) => areConnected(system.services, event.serviceId ?? "", serviceId)))),
        creation,
      ],
      actions: [],
    };
    this.records.set(incidentId, {
      correlationKey,
      evidence: this.createEvidence(system, pair, incidentServices),
      healthyObservations: 0,
      incident,
    });
    this.publish({ type: "incident-created", incident });
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
        .map((event) => ({ timestamp: event.timestamp, serviceId: event.serviceId ?? "", version: event.version, previousVersion: event.previousVersion, deploymentKind: event.deploymentKind, message: event.message })),
      alerts: [...alerts],
    };
  }

  private captureMetrics(system: ObservedSystem): void {
    for (const [incidentId, record] of this.records) {
      if (record.incident.status === "RESOLVED") continue;
      const histories = new Map(record.evidence.metricHistories.map((history) => [history.serviceId, [...history.samples]]));
      for (const service of system.services) {
        const samples = histories.get(service.id);
        if (!samples) continue;
        pushBounded(samples, { timestamp: system.timestamp, ...service.metrics }, MAX_INCIDENT_SAMPLES, PRESERVED_OPENING_SAMPLES);
        histories.set(service.id, samples);
      }
      this.records.set(incidentId, { ...record, evidence: { ...record.evidence, metricHistories: [...histories].map(([serviceId, samples]) => ({ serviceId, samples })) } });
    }
  }

  private captureLog(timelineEvent: IncidentTimelineEvent, log: CapturedLog): void {
    for (const [incidentId, record] of this.records) {
      if (record.incident.status === "RESOLVED" || !record.evidence.contextServiceIds.includes(log.serviceId)) continue;
      const logs = [...record.evidence.logs];
      pushBounded(logs, log, MAX_CAPTURED_LOGS, PRESERVED_OPENING_LOGS);
      this.updateRecord(incidentId, { ...record, evidence: { ...record.evidence, logs }, incident: { ...record.incident, timeline: [...record.incident.timeline, timelineEvent] } });
    }
  }

  private captureDeployment(timelineEvent: IncidentTimelineEvent): void {
    for (const [incidentId, record] of this.records) {
      if (record.incident.status === "RESOLVED" || !timelineEvent.serviceId || !record.evidence.contextServiceIds.includes(timelineEvent.serviceId)) continue;
      this.updateRecord(incidentId, {
        ...record,
        evidence: { ...record.evidence, deployments: [...record.evidence.deployments, { timestamp: timelineEvent.timestamp, serviceId: timelineEvent.serviceId, version: timelineEvent.version, previousVersion: timelineEvent.previousVersion, deploymentKind: timelineEvent.deploymentKind, message: timelineEvent.message }] },
        incident: { ...record.incident, timeline: [...record.incident.timeline, timelineEvent] },
      });
    }
  }

  private observeRecovery(system: ObservedSystem): void {
    for (const [incidentId, record] of this.records) {
      if (record.incident.status === "RESOLVED") continue;
      const hasActiveSourceAlert = record.incident.alerts.some((alert) => this.activeAlerts.has(alertKey(alert)));
      if (hasActiveSourceAlert) {
        if (record.healthyObservations !== 0) this.records.set(incidentId, { ...record, healthyObservations: 0 });
        continue;
      }
      const healthyObservations = record.healthyObservations + 1;
      if (healthyObservations < RECOVERY_OBSERVATIONS_REQUIRED || record.incident.status === "MONITORING") {
        this.records.set(incidentId, { ...record, healthyObservations });
        continue;
      }
      const incident: DetectedIncident = {
        ...record.incident,
        status: "MONITORING",
        timeline: [...record.incident.timeline, {
          type: "RECOVERY_MONITORING",
          timestamp: system.timestamp,
          message: `Affected alert conditions remained healthy for ${RECOVERY_OBSERVATIONS_REQUIRED} observations; monitoring recovery`,
        }],
      };
      this.updateRecord(incidentId, { ...record, healthyObservations, incident });
    }
  }

  private updateRecord(incidentId: string, record: IncidentRecord): void {
    this.records.set(incidentId, record);
    this.publish({ type: "incident-updated", incident: record.incident });
  }

  private proposeAction(incident: DetectedIncident, recommendation: SuggestedActionRecommendation, timestamp: string): SuggestedAction | undefined {
    const existing = incident.actions.find((action) => action.type === recommendation.type && action.targetServiceId === recommendation.targetServiceId && action.fromVersion === recommendation.fromVersion && action.toVersion === recommendation.toVersion);
    if (existing) return undefined;
    return proposeRollback({
      id: `ACT-${this.nextActionNumber++}`,
      incidentId: incident.id,
      targetServiceId: recommendation.targetServiceId,
      fromVersion: recommendation.fromVersion,
      toVersion: recommendation.toVersion,
      reasoning: recommendation.reasoning,
      evidenceIds: recommendation.evidenceIds,
      risk: recommendation.risk,
      proposedAt: timestamp,
    });
  }

  private actionRecord(incidentId: string, actionId: string): { readonly record: IncidentRecord; readonly action: SuggestedAction } {
    const record = this.records.get(incidentId);
    if (!record) throw new IncidentActionError("Incident not found");
    if (record.incident.status === "RESOLVED") throw new IncidentActionError("A resolved incident cannot accept a mitigation decision");
    const action = record.incident.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new IncidentActionError("Suggested action not found");
    return { record, action };
  }

  private updateAction(record: IncidentRecord, action: SuggestedAction, timelineEvent: IncidentTimelineEvent): void {
    const incident: DetectedIncident = {
      ...record.incident,
      actions: record.incident.actions.map((candidate) => candidate.id === action.id ? action : candidate),
      timeline: [...record.incident.timeline, timelineEvent],
    };
    this.updateRecord(incident.id, { ...record, incident });
  }

  private publish(event: IncidentEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

function elapsedMs(laterTimestamp: string, earlierTimestamp: string): number {
  return Math.max(0, Date.parse(laterTimestamp) - Date.parse(earlierTimestamp));
}

function alertKey(alert: Pick<Alert, "policyId" | "serviceId">): string {
  return `${alert.policyId}:${alert.serviceId}`;
}

function pairCorrelationKey(pair: readonly [Alert, Alert]): string {
  return pair.map(alertKey).sort().join("|");
}

function highestSeverity(alerts: readonly Alert[]): AlertPolicy["severity"] {
  const rank: Record<AlertPolicy["severity"], number> = { "SEV-1": 1, "SEV-2": 2, "SEV-3": 3, "SEV-4": 4 };
  return alerts.reduce<AlertPolicy["severity"]>((highest, alert) => rank[alert.severity] < rank[highest] ? alert.severity : highest, "SEV-4");
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
    if (current === undefined) break;
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

function actionError(error: unknown): IncidentActionError {
  if (error instanceof IncidentActionError) return error;
  if (error instanceof ActionTransitionError) return new IncidentActionError(error.message);
  if (error instanceof IncidentCommandError) return new IncidentActionError(error.message);
  return new IncidentActionError("Unable to update suggested action");
}
