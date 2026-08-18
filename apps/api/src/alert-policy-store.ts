import {
  alertMetricNames,
  type AlertComparator,
  type AlertMetricName,
  type AlertPolicy,
  type AlertPolicyDraft,
  type AlertPolicyScope,
  type AlertSeverity,
  defaultAlertPolicies,
  unitForMetric,
} from "../../../packages/domain/src/alert-policy.ts";

export class AlertPolicyValidationError extends Error {}
export class AlertPolicyNotFoundError extends Error {}

export class AlertPolicyStore {
  private readonly policies = new Map<string, AlertPolicy>();
  private nextId = 1;
  private readonly knownServiceIds: readonly string[];

  constructor(knownServiceIds: readonly string[], initialPolicies: readonly AlertPolicy[] = defaultAlertPolicies) {
    this.knownServiceIds = knownServiceIds;
    for (const policy of initialPolicies) this.policies.set(policy.id, policy);
  }

  list(): readonly AlertPolicy[] {
    return [...this.policies.values()];
  }

  create(input: unknown): AlertPolicy {
    const draft = parseAlertPolicyDraft(input, this.knownServiceIds);
    const policy: AlertPolicy = { id: this.allocateId(), ...draft, unit: unitForMetric(draft.metric) };
    this.policies.set(policy.id, policy);
    return policy;
  }

  update(id: string, input: unknown): AlertPolicy {
    if (!this.policies.has(id)) throw new AlertPolicyNotFoundError("Alert policy not found");
    const draft = parseAlertPolicyDraft(input, this.knownServiceIds);
    const policy: AlertPolicy = { id, ...draft, unit: unitForMetric(draft.metric) };
    this.policies.set(id, policy);
    return policy;
  }

  private allocateId(): string {
    const id = `POL-${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}

function parseAlertPolicyDraft(value: unknown, knownServiceIds: readonly string[]): AlertPolicyDraft {
  if (!isRecord(value)) throw new AlertPolicyValidationError("Alert policy must be a JSON object");
  const name = requiredString(value.name, "name", 100);
  const metric = enumValue(value.metric, alertMetricNames, "metric");
  const comparator = enumValue(value.comparator, ["GREATER_THAN", "LESS_THAN"] as const, "comparator") as AlertComparator;
  const threshold = requiredNumber(value.threshold, "threshold", 0, 1_000_000);
  const breachDurationSeconds = requiredInteger(value.breachDurationSeconds, "breachDurationSeconds", 0, 3_600);
  const severity = enumValue(value.severity, ["SEV-1", "SEV-2", "SEV-3", "SEV-4"] as const, "severity") as AlertSeverity;
  if (typeof value.enabled !== "boolean") throw new AlertPolicyValidationError("enabled must be true or false");
  return {
    name,
    metric: metric as AlertMetricName,
    comparator,
    threshold,
    breachDurationSeconds,
    severity,
    enabled: value.enabled,
    scope: parseScope(value.scope, knownServiceIds),
  };
}

function parseScope(value: unknown, knownServiceIds: readonly string[]): AlertPolicyScope {
  if (!isRecord(value) || typeof value.type !== "string") throw new AlertPolicyValidationError("scope.type is required");
  if (value.type === "ALL_SERVICES") return { type: "ALL_SERVICES" };
  if (value.type !== "SELECTED_SERVICES") throw new AlertPolicyValidationError("scope.type must target all or selected services");
  if (!Array.isArray(value.serviceIds) || value.serviceIds.length === 0 || !value.serviceIds.every((id) => typeof id === "string" && knownServiceIds.includes(id))) {
    throw new AlertPolicyValidationError("scope.serviceIds must contain one or more known services");
  }
  return { type: "SELECTED_SERVICES", serviceIds: [...new Set(value.serviceIds)] };
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new AlertPolicyValidationError(`${field} is invalid`);
  return value as T;
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximumLength) throw new AlertPolicyValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function requiredNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new AlertPolicyValidationError(`${field} is invalid`);
  return value;
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) throw new AlertPolicyValidationError(`${field} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
