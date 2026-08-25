export type IncidentActor = {
  readonly id: string;
  readonly name: string;
};

export type IncidentCommander = IncidentActor & {
  readonly assignedAt: string;
};

export class IncidentCommandError extends Error {}

export function assignIncidentCommander(existing: IncidentCommander | undefined, actor: IncidentActor, assignedAt: string): IncidentCommander {
  if (existing && existing.id !== actor.id) {
    throw new IncidentCommandError(`Incident command is already held by ${existing.name}`);
  }
  return existing ?? { ...actor, assignedAt };
}

export function requireIncidentCommander(commander: IncidentCommander | undefined, actor: IncidentActor): void {
  if (!commander) throw new IncidentCommandError("An Incident Commander must be assigned before this operation can proceed");
  if (commander.id !== actor.id) throw new IncidentCommandError(`Incident Commander ${commander.name} must approve this action`);
}
