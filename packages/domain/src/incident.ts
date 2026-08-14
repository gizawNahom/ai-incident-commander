export const IncidentStatus = {
  DETECTED: "DETECTED",
  INVESTIGATING: "INVESTIGATING",
  IDENTIFIED: "IDENTIFIED",
  MITIGATING: "MITIGATING",
  MONITORING: "MONITORING",
  RESOLVED: "RESOLVED",
} as const;

export type IncidentStatus = (typeof IncidentStatus)[keyof typeof IncidentStatus];
export type Severity = "SEV_1" | "SEV_2" | "SEV_3" | "SEV_4";

type IncidentDraft = {
  id: string;
  title: string;
  severity: Severity;
  startedAt: Date;
};

const permittedTransitions: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  DETECTED: [IncidentStatus.INVESTIGATING],
  INVESTIGATING: [IncidentStatus.IDENTIFIED],
  IDENTIFIED: [IncidentStatus.MITIGATING],
  MITIGATING: [IncidentStatus.MONITORING],
  MONITORING: [IncidentStatus.RESOLVED],
  RESOLVED: [],
};

export class Incident {
  public status: IncidentStatus;
  public readonly id: string;
  public readonly title: string;
  public readonly severity: Severity;
  public readonly startedAt: Date;

  private constructor(id: string, title: string, severity: Severity, startedAt: Date) {
    this.id = id;
    this.title = title;
    this.severity = severity;
    this.startedAt = startedAt;
    this.status = IncidentStatus.DETECTED;
  }

  static detect(draft: IncidentDraft): Incident {
    return new Incident(draft.id, draft.title, draft.severity, draft.startedAt);
  }

  transitionTo(next: IncidentStatus): void {
    if (!permittedTransitions[this.status].includes(next)) {
      throw new Error(`Cannot transition incident from ${this.status} to ${next}`);
    }
    this.status = next;
  }
}
