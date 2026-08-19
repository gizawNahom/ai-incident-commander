export const alertMetricNames = ["latencyMs", "errorRate", "trafficRpm", "cpuPercent", "queueLag"] as const;

export type AlertMetricName = (typeof alertMetricNames)[number];
export type AlertComparator = "GREATER_THAN" | "LESS_THAN";
export type AlertSeverity = "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4";
export type AlertPolicyScope =
  | { readonly type: "ALL_SERVICES" }
  | { readonly type: "SELECTED_SERVICES"; readonly serviceIds: readonly string[] };

export type AlertPolicy = {
  readonly id: string;
  readonly name: string;
  readonly metric: AlertMetricName;
  readonly comparator: AlertComparator;
  readonly threshold: number;
  readonly unit: "ms" | "%" | "rpm" | "messages";
  readonly breachDurationSeconds: number;
  readonly severity: AlertSeverity;
  readonly enabled: boolean;
  readonly scope: AlertPolicyScope;
};

export type AlertPolicyDraft = Omit<AlertPolicy, "id" | "unit">;

export const defaultAlertPolicies: readonly AlertPolicy[] = [
  {
    id: "latency-critical",
    name: "latency above 1,000 ms",
    metric: "latencyMs",
    comparator: "GREATER_THAN",
    threshold: 1_000,
    unit: "ms",
    breachDurationSeconds: 0,
    severity: "SEV-1",
    enabled: true,
    scope: { type: "ALL_SERVICES" },
  },
  {
    id: "error-rate-critical",
    name: "error rate above 10%",
    metric: "errorRate",
    comparator: "GREATER_THAN",
    threshold: 10,
    unit: "%",
    breachDurationSeconds: 0,
    severity: "SEV-1",
    enabled: true,
    scope: { type: "ALL_SERVICES" },
  },
];

export function unitForMetric(metric: AlertMetricName): AlertPolicy["unit"] {
  if (metric === "latencyMs") return "ms";
  if (metric === "errorRate" || metric === "cpuPercent") return "%";
  if (metric === "queueLag") return "messages";
  return "rpm";
}

export function policyAppliesToService(policy: AlertPolicy, serviceId: string): boolean {
  return policy.scope.type === "ALL_SERVICES" || policy.scope.serviceIds.includes(serviceId);
}

export function policyIsBreached(policy: AlertPolicy, observedValue: number): boolean {
  return policy.comparator === "GREATER_THAN"
    ? observedValue > policy.threshold
    : observedValue < policy.threshold;
}
