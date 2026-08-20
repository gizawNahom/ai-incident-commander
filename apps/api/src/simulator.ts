export const serviceIds = [
  "api-gateway",
  "auth-service",
  "checkout-service",
  "payment-service",
  "inventory-service",
  "notification-service",
  "postgresql",
  "redis",
  "kafka",
] as const;

export type ServiceId = (typeof serviceIds)[number];
export type ServiceHealth = "healthy" | "degraded" | "critical";
export type ScenarioName = "healthy" | "bad-payment-deployment" | "redis-degradation" | "kafka-backlog" | "service-outage" | "recovering";
type FailureScenario = Exclude<ScenarioName, "healthy" | "recovering">;

export type ServiceMetrics = {
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly trafficRpm: number;
  readonly cpuPercent: number;
  readonly queueLag: number;
};

export type ServiceSnapshot = {
  readonly id: ServiceId;
  readonly name: string;
  readonly kind: "service" | "datastore" | "stream";
  readonly version: string;
  readonly health: ServiceHealth;
  readonly dependencies: readonly ServiceId[];
  readonly metrics: ServiceMetrics;
};

export type SystemSnapshot = {
  readonly timestamp: string;
  readonly scenario: ScenarioName;
  readonly services: readonly ServiceSnapshot[];
};

export type MetricHistorySample = ServiceMetrics & { readonly timestamp: string };
export type MetricHistory = { readonly serviceId: ServiceId; readonly samples: readonly MetricHistorySample[] };

export type TelemetrySample = {
  readonly type: "telemetry";
  readonly timestamp: string;
  readonly serviceId: ServiceId;
  readonly metric: "latency_ms";
  readonly value: number;
};

export type DeploymentEvent = {
  readonly type: "deployment";
  readonly timestamp: string;
  readonly serviceId: ServiceId;
  readonly version: string;
  readonly previousVersion: string;
  readonly deploymentKind: "RELEASE" | "ROLLBACK";
  readonly message: string;
};

export type LogEvent = {
  readonly type: "log";
  readonly timestamp: string;
  readonly serviceId: ServiceId;
  readonly level: "warn" | "error" | "info";
  readonly message: string;
};

export type SystemEvent = { readonly type: "system"; readonly system: SystemSnapshot };
export type SimulatorEvent = TelemetrySample | DeploymentEvent | LogEvent | SystemEvent;
export type RollbackDeploymentInput = { readonly serviceId: ServiceId; readonly fromVersion: string; readonly toVersion: string };
export type SimulatorActionResult = { readonly ok: boolean; readonly message: string };

type Subscriber = (event: SimulatorEvent) => void;
type SimulatorOptions = { seed: number; now: () => Date };

type ServiceBlueprint = {
  readonly id: ServiceId;
  readonly name: string;
  readonly kind: ServiceSnapshot["kind"];
  readonly version: string;
  readonly dependencies: readonly ServiceId[];
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly trafficRpm: number;
  readonly cpuPercent: number;
  readonly queueLag: number;
};

const blueprint: readonly ServiceBlueprint[] = [
  { id: "api-gateway", name: "API Gateway", kind: "service", version: "v2.14.0", dependencies: ["auth-service", "checkout-service"], latencyMs: 105, errorRate: 0.2, trafficRpm: 4_820, cpuPercent: 42, queueLag: 0 },
  { id: "auth-service", name: "Auth Service", kind: "service", version: "v3.9.1", dependencies: ["redis", "postgresql"], latencyMs: 66, errorRate: 0.1, trafficRpm: 2_780, cpuPercent: 31, queueLag: 0 },
  { id: "checkout-service", name: "Checkout Service", kind: "service", version: "v4.2.0", dependencies: ["inventory-service", "payment-service"], latencyMs: 92, errorRate: 0.3, trafficRpm: 1_360, cpuPercent: 48, queueLag: 0 },
  { id: "payment-service", name: "Payment Service", kind: "service", version: "v1.8.2", dependencies: ["redis", "kafka", "postgresql"], latencyMs: 119, errorRate: 0.2, trafficRpm: 1_360, cpuPercent: 46, queueLag: 0 },
  { id: "inventory-service", name: "Inventory Service", kind: "service", version: "v2.7.4", dependencies: ["postgresql"], latencyMs: 74, errorRate: 0.1, trafficRpm: 1_360, cpuPercent: 38, queueLag: 0 },
  { id: "notification-service", name: "Notification Service", kind: "service", version: "v1.16.2", dependencies: ["kafka"], latencyMs: 86, errorRate: 0.2, trafficRpm: 980, cpuPercent: 28, queueLag: 0 },
  { id: "postgresql", name: "PostgreSQL", kind: "datastore", version: "15.5", dependencies: [], latencyMs: 8, errorRate: 0, trafficRpm: 8_400, cpuPercent: 51, queueLag: 0 },
  { id: "redis", name: "Redis", kind: "datastore", version: "7.2", dependencies: [], latencyMs: 5, errorRate: 0, trafficRpm: 12_100, cpuPercent: 37, queueLag: 0 },
  { id: "kafka", name: "Kafka", kind: "stream", version: "3.6", dependencies: [], latencyMs: 14, errorRate: 0, trafficRpm: 3_200, cpuPercent: 34, queueLag: 0 },
];

export class TelemetrySimulator {
  private readonly subscribers = new Set<Subscriber>();
  private readonly options: SimulatorOptions;
  private state: number;
  private tick = 0;
  private scenario: ScenarioName = "healthy";
  private failureScenario: FailureScenario | undefined;
  private outageTarget: ServiceId | undefined;
  private degradationStage = 0;
  private recoveryTicks = 0;
  private latest: TelemetrySample;
  private system: SystemSnapshot;
  private readonly historyByService = new Map<ServiceId, MetricHistorySample[]>();

  constructor(options: SimulatorOptions) {
    this.options = options;
    this.state = options.seed;
    this.system = this.buildSystem();
    this.recordHistory(this.system);
    this.latest = this.toGatewaySample(this.system);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  current(): TelemetrySample {
    return this.latest;
  }

  snapshot(): SystemSnapshot {
    return this.system;
  }

  history(serviceId: ServiceId): MetricHistory {
    return { serviceId, samples: [...(this.historyByService.get(serviceId) ?? [])] };
  }

  triggerBadPaymentDeployment(): void {
    if (!this.activateScenario("bad-payment-deployment")) return;
    this.emit({
      type: "deployment",
      timestamp: this.options.now().toISOString(),
      serviceId: "payment-service",
      version: "v1.8.3",
      previousVersion: "v1.8.2",
      deploymentKind: "RELEASE",
      message: "payment-service v1.8.3 deployment completed",
    });
  }

  triggerRedisDegradation(): void {
    if (!this.activateScenario("redis-degradation")) return;
    this.emit({ type: "log", timestamp: this.options.now().toISOString(), serviceId: "redis", level: "warn", message: "Redis latency degradation injected" });
  }

  triggerKafkaBacklog(): void {
    if (!this.activateScenario("kafka-backlog")) return;
    this.emit({ type: "log", timestamp: this.options.now().toISOString(), serviceId: "kafka", level: "warn", message: "Kafka consumer processing slowdown injected" });
  }

  triggerServiceOutage(serviceId: ServiceId): void {
    if (this.scenario === "service-outage" && this.outageTarget === serviceId) return;
    this.activateScenario("service-outage");
    this.outageTarget = serviceId;
    this.emit({ type: "log", timestamp: this.options.now().toISOString(), serviceId, level: "error", message: `${serviceId} marked unavailable by outage simulation` });
  }

  recover(): void {
    if (this.scenario === "healthy") return;
    this.scenario = "recovering";
    this.recoveryTicks = 0;
    if (this.failureScenario === "bad-payment-deployment") {
      this.emit({
        type: "deployment",
        timestamp: this.options.now().toISOString(),
        serviceId: "payment-service",
        version: "v1.8.2",
        previousVersion: "v1.8.3",
        deploymentKind: "ROLLBACK",
        message: "payment-service rollback to v1.8.2 started",
      });
      return;
    }
    const target = this.failureScenario === "service-outage" ? this.outageTarget : this.failureScenario === "redis-degradation" ? "redis" : "kafka";
    if (target) this.emit({ type: "log", timestamp: this.options.now().toISOString(), serviceId: target, level: "info", message: `${target} recovery sequence started` });
  }

  rollbackDeployment(input: RollbackDeploymentInput): SimulatorActionResult {
    const service = this.system.services.find((candidate) => candidate.id === input.serviceId);
    const baseline = blueprint.find((candidate) => candidate.id === input.serviceId);
    const matchesInjectedDeployment = this.failureScenario === "bad-payment-deployment" && service?.version === input.fromVersion && baseline?.version === input.toVersion;
    if (!matchesInjectedDeployment) {
      return { ok: false, message: `No active defective deployment matches ${input.serviceId} ${input.fromVersion} → ${input.toVersion}` };
    }
    this.recover();
    this.system = {
      ...this.system,
      scenario: "recovering",
      services: this.system.services.map((candidate) => candidate.id === input.serviceId ? { ...candidate, version: input.toVersion } : candidate),
    };
    this.latest = this.toGatewaySample(this.system);
    this.emit({ type: "system", system: this.system });
    return { ok: true, message: `${input.serviceId} rollback to ${input.toVersion} started` };
  }

  advance(): TelemetrySample {
    this.tick += 1;
    if (this.failureScenario && this.scenario !== "recovering") this.degradationStage = Math.min(3, this.degradationStage + 1);
    if (this.scenario === "recovering") {
      this.recoveryTicks += 1;
      this.degradationStage = Math.max(0, 3 - this.recoveryTicks);
      if (this.recoveryTicks >= 4) {
        this.scenario = "healthy";
        this.degradationStage = 0;
        this.failureScenario = undefined;
        this.outageTarget = undefined;
      }
    }
    this.system = this.buildSystem();
    this.recordHistory(this.system);
    this.latest = this.toGatewaySample(this.system);
    this.emit(this.latest);
    this.emitFailureLogs();
    this.emit({ type: "system", system: this.system });
    return this.latest;
  }

  private buildSystem(): SystemSnapshot {
    const timestamp = this.options.now().toISOString();
    return {
      timestamp,
      scenario: this.scenario,
      services: blueprint.map((service) => this.buildService(service)),
    };
  }

  private buildService(service: ServiceBlueprint): ServiceSnapshot {
    const baseline = this.baselineMetrics(service);
    if (this.degradationStage === 0 || !this.failureScenario) {
      return { ...service, health: "healthy", version: service.version, metrics: baseline };
    }
    if (this.failureScenario === "bad-payment-deployment") return this.applyBadPaymentDeployment(service, baseline);
    if (this.failureScenario === "redis-degradation") return this.applyRedisDegradation(service, baseline);
    if (this.failureScenario === "kafka-backlog") return this.applyKafkaBacklog(service, baseline);
    return this.applyServiceOutage(service, baseline);
  }

  private baselineMetrics(service: ServiceBlueprint): ServiceMetrics {
    const jitter = this.jitter();
    return {
      latencyMs: round(Math.max(1, service.latencyMs + jitter * Math.min(1, service.latencyMs / 100))),
      errorRate: round(Math.max(0, service.errorRate + jitter / 70)),
      trafficRpm: Math.round(Math.max(1, service.trafficRpm + jitter * 12)),
      cpuPercent: round(Math.max(1, service.cpuPercent + jitter / 2)),
      queueLag: service.queueLag,
    };
  }

  private applyBadPaymentDeployment(service: ServiceBlueprint, metrics: ServiceMetrics): ServiceSnapshot {
    const stage = this.degradationStage;
    if (service.id === "payment-service") {
      return {
        ...service,
        version: this.scenario === "recovering" ? "v1.8.2" : "v1.8.3",
        health: stage >= 3 ? "critical" : "degraded",
        metrics: { ...metrics, latencyMs: round(119 + stage * 700 + this.jitter()), errorRate: round(0.2 + stage * 9), cpuPercent: round(46 + stage * 14) },
      };
    }
    if (service.id === "checkout-service") {
      return {
        ...service,
        health: "degraded",
        metrics: { ...metrics, latencyMs: round(92 + stage * 120), errorRate: round(0.3 + stage * 6.4), cpuPercent: round(48 + stage * 8) },
      };
    }
    if (service.id === "redis") {
      return {
        ...service,
        health: "degraded",
        metrics: { ...metrics, latencyMs: round(5 + stage * 35), errorRate: round(stage * 0.2), cpuPercent: round(37 + stage * 10) },
      };
    }
    if (service.id === "api-gateway") {
      return { ...service, health: "degraded", metrics: { ...metrics, latencyMs: round(105 + stage * 28), errorRate: round(0.2 + stage * 1.4) } };
    }
    return { ...service, health: "healthy", version: service.version, metrics };
  }

  private applyRedisDegradation(service: ServiceBlueprint, metrics: ServiceMetrics): ServiceSnapshot {
    const stage = this.degradationStage;
    if (service.id === "redis") {
      return { ...service, health: stage >= 3 ? "critical" : "degraded", metrics: { ...metrics, latencyMs: round(5 + stage * 550), errorRate: round(stage * 0.5), cpuPercent: round(37 + stage * 16) } };
    }
    const distance = dependencyDistance(service.id, "redis");
    if (distance === undefined) return { ...service, health: "healthy", metrics };
    const direct = distance === 1;
    return {
      ...service,
      health: "degraded",
      metrics: {
        ...metrics,
        latencyMs: round(service.latencyMs + stage * (direct ? 600 : 180) / distance),
        errorRate: round(service.errorRate + stage * (direct ? 3 : 7.5) / distance),
        cpuPercent: round(service.cpuPercent + stage * 8 / distance),
      },
    };
  }

  private applyKafkaBacklog(service: ServiceBlueprint, metrics: ServiceMetrics): ServiceSnapshot {
    const stage = this.degradationStage;
    if (service.id === "kafka") {
      return { ...service, health: stage >= 3 ? "critical" : "degraded", metrics: { ...metrics, latencyMs: round(14 + stage * 400), queueLag: stage * 7_500, cpuPercent: round(34 + stage * 12) } };
    }
    const distance = dependencyDistance(service.id, "kafka");
    if (distance === undefined) return { ...service, health: "healthy", metrics };
    return {
      ...service,
      health: "degraded",
      metrics: {
        ...metrics,
        latencyMs: round(service.latencyMs + stage * 260 / distance),
        errorRate: round(service.errorRate + stage * 5 / distance),
        cpuPercent: round(service.cpuPercent + stage * 7 / distance),
        queueLag: stage * Math.round(1_500 / distance),
      },
    };
  }

  private applyServiceOutage(service: ServiceBlueprint, metrics: ServiceMetrics): ServiceSnapshot {
    const target = this.outageTarget;
    if (!target) return { ...service, health: "healthy", metrics };
    const stage = this.degradationStage;
    if (service.id === target) {
      return { ...service, health: "critical", metrics: { ...metrics, latencyMs: round(1_000 + stage * 1_500), errorRate: 100, trafficRpm: 1, cpuPercent: 5 } };
    }
    const distance = dependencyDistance(service.id, target);
    if (distance === undefined) return { ...service, health: "healthy", metrics };
    const direct = distance === 1;
    return {
      ...service,
      health: direct && stage >= 3 ? "critical" : "degraded",
      metrics: {
        ...metrics,
        latencyMs: round(service.latencyMs + stage * 500 / distance),
        errorRate: round(service.errorRate + stage * 6 / distance),
        trafficRpm: Math.max(1, Math.round(service.trafficRpm * (1 - stage * 0.12 / distance))),
      },
    };
  }

  private toGatewaySample(system: SystemSnapshot): TelemetrySample {
    const gateway = system.services.find((service) => service.id === "api-gateway");
    if (!gateway) throw new Error("API Gateway is required by the simulator");
    return { type: "telemetry", timestamp: system.timestamp, serviceId: gateway.id, metric: "latency_ms", value: gateway.metrics.latencyMs };
  }

  private emitFailureLogs(): void {
    if (this.degradationStage < 2) return;
    const timestamp = this.options.now().toISOString();
    if (this.failureScenario === "bad-payment-deployment") {
      this.emit({ type: "log", timestamp, serviceId: "redis", level: "warn", message: `redis request wait exceeded ${this.degradationStage * 35}ms` });
      this.emit({ type: "log", timestamp, serviceId: "payment-service", level: "error", message: "redis connection pool timeout: checkout authorization delayed" });
      this.emit({ type: "log", timestamp, serviceId: "checkout-service", level: "error", message: "payment authorization request timed out" });
      return;
    }
    if (this.failureScenario === "redis-degradation") {
      this.emit({ type: "log", timestamp, serviceId: "redis", level: "warn", message: `Redis latency exceeded ${this.degradationStage * 550}ms` });
      this.emit({ type: "log", timestamp, serviceId: "payment-service", level: "error", message: "Redis dependency timeout delaying payment authorization" });
      this.emit({ type: "log", timestamp, serviceId: "checkout-service", level: "warn", message: "Checkout requests delayed by payment dependency" });
      return;
    }
    if (this.failureScenario === "kafka-backlog") {
      this.emit({ type: "log", timestamp, serviceId: "kafka", level: "warn", message: `Kafka consumer lag reached ${this.degradationStage * 7_500} messages` });
      this.emit({ type: "log", timestamp, serviceId: "notification-service", level: "error", message: "Notification delivery delayed by Kafka consumer backlog" });
      return;
    }
    if (this.failureScenario === "service-outage" && this.outageTarget) {
      this.emit({ type: "log", timestamp, serviceId: this.outageTarget, level: "error", message: `${this.outageTarget} remains unavailable` });
    }
  }

  private recordHistory(system: SystemSnapshot): void {
    for (const service of system.services) {
      const samples = this.historyByService.get(service.id) ?? [];
      samples.push({ timestamp: system.timestamp, ...service.metrics });
      if (samples.length > 120) samples.shift();
      this.historyByService.set(service.id, samples);
    }
  }

  private emit(event: SimulatorEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private jitter(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return (this.state / 4_294_967_296) * 10 - 5;
  }

  private activateScenario(scenario: FailureScenario): boolean {
    if (this.scenario === scenario) return false;
    this.scenario = scenario;
    this.failureScenario = scenario;
    this.outageTarget = undefined;
    this.degradationStage = 0;
    this.recoveryTicks = 0;
    return true;
  }
}

function dependencyDistance(from: ServiceId, target: ServiceId): number | undefined {
  if (from === target) return 0;
  const dependencies = new Map(blueprint.map((service) => [service.id, service.dependencies]));
  const pending: Array<{ readonly serviceId: ServiceId; readonly distance: number }> = [{ serviceId: from, distance: 0 }];
  const visited = new Set<ServiceId>([from]);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    for (const dependency of dependencies.get(current.serviceId) ?? []) {
      if (dependency === target) return current.distance + 1;
      if (!visited.has(dependency)) {
        visited.add(dependency);
        pending.push({ serviceId: dependency, distance: current.distance + 1 });
      }
    }
  }
  return undefined;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
