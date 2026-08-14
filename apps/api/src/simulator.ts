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
export type ScenarioName = "healthy" | "bad-payment-deployment" | "recovering";

export type ServiceMetrics = {
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly trafficRpm: number;
  readonly cpuPercent: number;
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
  readonly serviceId: "payment-service";
  readonly version: "v1.8.3" | "v1.8.2";
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
};

const blueprint: readonly ServiceBlueprint[] = [
  { id: "api-gateway", name: "API Gateway", kind: "service", version: "v2.14.0", dependencies: ["auth-service", "checkout-service"], latencyMs: 105, errorRate: 0.2, trafficRpm: 4_820, cpuPercent: 42 },
  { id: "auth-service", name: "Auth Service", kind: "service", version: "v3.9.1", dependencies: ["redis", "postgresql"], latencyMs: 66, errorRate: 0.1, trafficRpm: 2_780, cpuPercent: 31 },
  { id: "checkout-service", name: "Checkout Service", kind: "service", version: "v4.2.0", dependencies: ["inventory-service", "payment-service"], latencyMs: 92, errorRate: 0.3, trafficRpm: 1_360, cpuPercent: 48 },
  { id: "payment-service", name: "Payment Service", kind: "service", version: "v1.8.2", dependencies: ["redis", "kafka", "postgresql"], latencyMs: 119, errorRate: 0.2, trafficRpm: 1_360, cpuPercent: 46 },
  { id: "inventory-service", name: "Inventory Service", kind: "service", version: "v2.7.4", dependencies: ["postgresql"], latencyMs: 74, errorRate: 0.1, trafficRpm: 1_360, cpuPercent: 38 },
  { id: "notification-service", name: "Notification Service", kind: "service", version: "v1.16.2", dependencies: ["kafka"], latencyMs: 86, errorRate: 0.2, trafficRpm: 980, cpuPercent: 28 },
  { id: "postgresql", name: "PostgreSQL", kind: "datastore", version: "15.5", dependencies: [], latencyMs: 8, errorRate: 0, trafficRpm: 8_400, cpuPercent: 51 },
  { id: "redis", name: "Redis", kind: "datastore", version: "7.2", dependencies: [], latencyMs: 5, errorRate: 0, trafficRpm: 12_100, cpuPercent: 37 },
  { id: "kafka", name: "Kafka", kind: "stream", version: "3.6", dependencies: [], latencyMs: 14, errorRate: 0, trafficRpm: 3_200, cpuPercent: 34 },
];

export class TelemetrySimulator {
  private readonly subscribers = new Set<Subscriber>();
  private readonly options: SimulatorOptions;
  private state: number;
  private tick = 0;
  private scenario: ScenarioName = "healthy";
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
    if (this.scenario === "bad-payment-deployment") return;
    this.scenario = "bad-payment-deployment";
    this.degradationStage = 0;
    this.recoveryTicks = 0;
    this.emit({
      type: "deployment",
      timestamp: this.options.now().toISOString(),
      serviceId: "payment-service",
      version: "v1.8.3",
      message: "payment-service v1.8.3 deployment completed",
    });
  }

  recover(): void {
    if (this.scenario === "healthy") return;
    this.scenario = "recovering";
    this.recoveryTicks = 0;
    this.emit({
      type: "deployment",
      timestamp: this.options.now().toISOString(),
      serviceId: "payment-service",
      version: "v1.8.2",
      message: "payment-service rollback to v1.8.2 started",
    });
  }

  advance(): TelemetrySample {
    this.tick += 1;
    if (this.scenario === "bad-payment-deployment") this.degradationStage = Math.min(3, this.degradationStage + 1);
    if (this.scenario === "recovering") {
      this.recoveryTicks += 1;
      this.degradationStage = Math.max(0, 3 - this.recoveryTicks);
      if (this.recoveryTicks >= 4) {
        this.scenario = "healthy";
        this.degradationStage = 0;
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
    if (this.degradationStage === 0) {
      return { ...service, health: "healthy", version: service.version, metrics: baseline };
    }
    return this.applyBadPaymentDeployment(service, baseline);
  }

  private baselineMetrics(service: ServiceBlueprint): ServiceMetrics {
    const jitter = this.jitter();
    return {
      latencyMs: round(Math.max(1, service.latencyMs + jitter * Math.min(1, service.latencyMs / 100))),
      errorRate: round(Math.max(0, service.errorRate + jitter / 70)),
      trafficRpm: Math.round(Math.max(1, service.trafficRpm + jitter * 12)),
      cpuPercent: round(Math.max(1, service.cpuPercent + jitter / 2)),
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

  private toGatewaySample(system: SystemSnapshot): TelemetrySample {
    const gateway = system.services.find((service) => service.id === "api-gateway");
    if (!gateway) throw new Error("API Gateway is required by the simulator");
    return { type: "telemetry", timestamp: system.timestamp, serviceId: gateway.id, metric: "latency_ms", value: gateway.metrics.latencyMs };
  }

  private emitFailureLogs(): void {
    if (this.degradationStage < 2) return;
    const timestamp = this.options.now().toISOString();
    this.emit({ type: "log", timestamp, serviceId: "redis", level: "warn", message: `redis request wait exceeded ${this.degradationStage * 35}ms` });
    this.emit({ type: "log", timestamp, serviceId: "payment-service", level: "error", message: "redis connection pool timeout: checkout authorization delayed" });
    this.emit({ type: "log", timestamp, serviceId: "checkout-service", level: "error", message: "payment authorization request timed out" });
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
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
