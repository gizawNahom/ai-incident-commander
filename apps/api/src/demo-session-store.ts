import { randomUUID } from "node:crypto";

import type { IncidentActor } from "../../../packages/domain/src/incident-command.ts";

export type DemoUser = IncidentActor & {
  readonly role: "ENGINEER";
};

const users: readonly DemoUser[] = [
  { id: "maya-chen", name: "Maya Chen", role: "ENGINEER" },
  { id: "daniel-okafor", name: "Daniel Okafor", role: "ENGINEER" },
];

export class DemoSessionStore {
  private readonly sessions = new Map<string, DemoUser>();

  users(): readonly DemoUser[] {
    return users;
  }

  start(userId: string): { readonly token: string; readonly user: DemoUser } | undefined {
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) return undefined;
    const token = randomUUID();
    this.sessions.set(token, user);
    return { token, user };
  }

  find(cookieHeader: string | undefined): DemoUser | undefined {
    const token = cookieValue(cookieHeader, "incident_commander_session");
    return token ? this.sessions.get(token) : undefined;
  }

  end(cookieHeader: string | undefined): void {
    const token = cookieValue(cookieHeader, "incident_commander_session");
    if (token) this.sessions.delete(token);
  }
}

export function sessionCookie(token: string): string {
  return `incident_commander_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`;
}

export function expiredSessionCookie(): string {
  return "incident_commander_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const value of header.split(";")) {
    const [key, ...rest] = value.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
