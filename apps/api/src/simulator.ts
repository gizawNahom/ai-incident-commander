export type TelemetrySample = {
  readonly timestamp: string;
  readonly serviceId: "api-gateway";
  readonly metric: "latency_ms";
  readonly value: number;
};

type Subscriber = (sample: TelemetrySample) => void;
type SimulatorOptions = {
  seed: number;
  now: () => Date;
};

export class TelemetrySimulator {
  private readonly subscribers = new Set<Subscriber>();
  private readonly options: SimulatorOptions;
  private state: number;
  private latest: TelemetrySample;

  constructor(options: SimulatorOptions) {
    this.options = options;
    this.state = options.seed;
    this.latest = this.createSample();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  current(): TelemetrySample {
    return this.latest;
  }

  advance(): TelemetrySample {
    this.latest = this.createSample();
    for (const subscriber of this.subscribers) subscriber(this.latest);
    return this.latest;
  }

  private createSample(): TelemetrySample {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    const jitter = (this.state / 4_294_967_296) * 50 - 25;
    return {
      timestamp: this.options.now().toISOString(),
      serviceId: "api-gateway",
      metric: "latency_ms",
      value: Math.round((105 + jitter) * 10) / 10,
    };
  }
}
