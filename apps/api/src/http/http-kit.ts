import type { IncomingMessage, ServerResponse } from "node:http";

import type { DemoSessionStore, DemoUser } from "../demo-session-store.ts";

export type RequestContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly requestId: string;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type RouteHandler = (context: RequestContext, params: readonly string[]) => void | Promise<void>;

// A route either accepts any method or declares a handler per method; other methods receive 405.
// Captured pattern groups are URI-decoded before they reach the handler.
export type Route = {
  readonly pattern: RegExp;
  readonly handle: RouteHandler | Partial<Record<HttpMethod, RouteHandler>>;
};

export class RequestBodyError extends Error {}

export function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function sendError(context: RequestContext, status: number, error: string): void {
  json(context.response, status, { error, requestId: context.requestId });
}

export function log(event: string, fields: Record<string, string>): void {
  process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`);
}

export async function readJson(request: AsyncIterable<unknown>): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 16_384) throw new RequestBodyError("Request body is too large");
  }
  if (body.length === 0) throw new RequestBodyError("A JSON request body is required");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RequestBodyError("Request body must be valid JSON");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireDemoUser(context: RequestContext, sessions: DemoSessionStore): DemoUser | undefined {
  const user = sessions.find(context.request.headers.cookie);
  if (user) return user;
  sendError(context, 401, "Sign in with a demo account before performing incident operations");
  return undefined;
}
