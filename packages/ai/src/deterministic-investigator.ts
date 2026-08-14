export type InvestigationAlert = {
  readonly id: string;
  readonly serviceId: string;
  readonly title: string;
  readonly threshold: number;
  readonly observedValue: number;
  readonly unit: string;
  readonly triggeredAt: string;
};

export type InvestigationTimelineEvent = {
  readonly type: "DEPLOYMENT" | "LOG" | "ALERT_TRIGGERED" | "INCIDENT_CREATED";
  readonly timestamp: string;
  readonly message: string;
  readonly serviceId?: string;
};

export type InvestigationContext = {
  readonly incident: {
    readonly id: string;
    readonly title: string;
    readonly startedAt: string;
    readonly affectedServices: readonly string[];
    readonly alerts: readonly InvestigationAlert[];
    readonly timeline: readonly InvestigationTimelineEvent[];
  };
  readonly services: readonly {
    readonly id: string;
    readonly name: string;
    readonly dependencies: readonly string[];
  }[];
  readonly metricHistories: readonly {
    readonly serviceId: string;
    readonly samples: readonly {
      readonly timestamp: string;
      readonly latencyMs: number;
      readonly errorRate: number;
    }[];
  }[];
};

export type KnownEvidence = {
  readonly id: string;
  readonly kind: "deployment" | "alert" | "log" | "metric-change";
  readonly serviceId?: string;
  readonly timestamp?: string;
  readonly detail: string;
};

export type InvestigationHypothesis = {
  readonly targetServiceId?: string;
  readonly confidence: "high" | "medium" | "low";
  readonly inference: string;
  readonly evidenceIds: readonly string[];
};

export type ProposedMitigation = {
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly targetServiceId: string;
  readonly status: "PROPOSED";
  readonly risk: "medium";
  readonly rationale: "The deployment immediately preceded the observed degradation.";
};

export type Investigation = {
  readonly source: "deterministic" | "gemini";
  readonly fallbackReason?: string;
  readonly summary: string;
  readonly knownEvidence: readonly KnownEvidence[];
  readonly hypotheses: readonly InvestigationHypothesis[];
  readonly uncertainty: string;
  readonly suggestedAction?: ProposedMitigation;
};

export interface IncidentInvestigator {
  investigate(context: InvestigationContext): Investigation | Promise<Investigation>;
}

/**
 * An offline, deterministic investigator. It only turns supplied incident
 * evidence into explicit findings; it never talks to or mutates the simulator.
 */
export class DeterministicInvestigator implements IncidentInvestigator {
  investigate(context: InvestigationContext): Investigation {
    const deployment = this.findRelevantDeployment(context);
    const knownEvidence = [
      ...this.deploymentEvidence(deployment),
      ...this.alertEvidence(context.incident.alerts),
      ...this.logEvidence(context.incident.timeline),
      ...this.metricEvidence(context),
    ];
    const affectedNames = context.incident.affectedServices.map((serviceId) => serviceName(context.services, serviceId));
    const summary = `${context.incident.title} has ${context.incident.alerts.length} correlated alert${plural(context.incident.alerts.length)} affecting ${affectedNames.join(" and ")}.`;
    const deploymentEvidence = knownEvidence.filter((evidence) => evidence.kind === "deployment" || ((evidence.kind === "log" || evidence.kind === "metric-change") && evidence.serviceId === deployment?.serviceId));
    const targetServiceId = deployment?.serviceId ?? context.incident.alerts[0]?.serviceId;
    const hypothesis = deployment
      ? {
          targetServiceId,
          confidence: deploymentEvidence.length >= 2 ? "high" : "medium",
          inference: `${deployment.message} is the most likely initiating event because it preceded the correlated degradation.`,
          evidenceIds: deploymentEvidence.map((evidence) => evidence.id),
        } satisfies InvestigationHypothesis
      : {
          targetServiceId,
          confidence: "low",
          inference: "The available alerts show correlated degradation, but no initiating change is present in the incident evidence.",
          evidenceIds: knownEvidence.filter((evidence) => evidence.kind === "alert").map((evidence) => evidence.id),
        } satisfies InvestigationHypothesis;

    return {
      source: "deterministic",
      summary,
      knownEvidence,
      hypotheses: [hypothesis],
      uncertainty: deployment
        ? "The evidence establishes timing and correlation, but correlation does not prove the deployment caused the degradation."
        : "No relevant deployment is present in the available incident evidence, so the initiating cause remains unconfirmed.",
      suggestedAction: deployment
        ? {
            type: "ROLLBACK_DEPLOYMENT",
            targetServiceId: deployment.serviceId,
            status: "PROPOSED",
            risk: "medium",
            rationale: "The deployment immediately preceded the observed degradation.",
          }
        : undefined,
    };
  }

  private findRelevantDeployment(context: InvestigationContext): InvestigationTimelineEvent | undefined {
    return [...context.incident.timeline]
      .reverse()
      .find((event) => event.type === "DEPLOYMENT" && event.serviceId !== undefined && isConnectedToAffected(context.services, event.serviceId, context.incident.affectedServices));
  }

  private deploymentEvidence(deployment: InvestigationTimelineEvent | undefined): readonly KnownEvidence[] {
    return deployment ? [{ id: "evidence-deployment", kind: "deployment", serviceId: deployment.serviceId, timestamp: deployment.timestamp, detail: deployment.message }] : [];
  }

  private alertEvidence(alerts: readonly InvestigationAlert[]): readonly KnownEvidence[] {
    return alerts.map((alert) => ({
      id: `evidence-${alert.id}`,
      kind: "alert",
      serviceId: alert.serviceId,
      timestamp: alert.triggeredAt,
      detail: `${alert.title}: observed ${format(alert.observedValue)}${alert.unit} against a ${format(alert.threshold)}${alert.unit} threshold.`,
    }));
  }

  private logEvidence(timeline: readonly InvestigationTimelineEvent[]): readonly KnownEvidence[] {
    return timeline.filter((event) => event.type === "LOG").map((event, index) => ({
      id: `evidence-log-${index + 1}`,
      kind: "log",
      serviceId: event.serviceId,
      timestamp: event.timestamp,
      detail: event.message,
    }));
  }

  private metricEvidence(context: InvestigationContext): readonly KnownEvidence[] {
    return context.metricHistories
      .filter((history) => isConnectedToAffected(context.services, history.serviceId, context.incident.affectedServices))
      .flatMap((history) => {
        const first = history.samples[0];
        const latest = history.samples.at(-1);
        if (!first || !latest) return [];
        const latencyIncreased = latest.latencyMs > first.latencyMs;
        const errorRateIncreased = latest.errorRate > first.errorRate;
        return [
          ...(latencyIncreased ? [{
            id: `evidence-${history.serviceId}-latency`,
            kind: "metric-change" as const,
            serviceId: history.serviceId,
            timestamp: latest.timestamp,
            detail: `Latency increased from ${format(first.latencyMs)} ms to ${format(latest.latencyMs)} ms.`,
          }] : []),
          ...(errorRateIncreased ? [{
            id: `evidence-${history.serviceId}-errors`,
            kind: "metric-change" as const,
            serviceId: history.serviceId,
            timestamp: latest.timestamp,
            detail: `Error rate increased from ${format(first.errorRate)}% to ${format(latest.errorRate)}%.`,
          }] : []),
        ];
      });
  }
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function serviceName(services: InvestigationContext["services"], serviceId: string): string {
  return services.find((service) => service.id === serviceId)?.name ?? serviceId;
}

function isConnectedToAffected(services: InvestigationContext["services"], serviceId: string, affectedServices: readonly string[]): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const service of services) {
    const neighbours = adjacency.get(service.id) ?? new Set<string>();
    adjacency.set(service.id, neighbours);
    for (const dependency of service.dependencies) {
      neighbours.add(dependency);
      const reverse = adjacency.get(dependency) ?? new Set<string>();
      reverse.add(service.id);
      adjacency.set(dependency, reverse);
    }
  }
  const seen = new Set([serviceId]);
  const pending = [serviceId];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current !== undefined && affectedServices.includes(current)) return true;
    for (const neighbour of adjacency.get(current ?? "") ?? []) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        pending.push(neighbour);
      }
    }
  }
  return false;
}
