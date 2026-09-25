import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { log, sendError, type HttpMethod, type RequestContext, type Route, type RouteHandler } from "./http-kit.ts";

export function createRouter(routes: readonly Route[], fallback: RouteHandler): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    const url = new URL(request.url ?? "/", "http://localhost");
    log("request_received", { requestId, method: request.method ?? "UNKNOWN", path: url.pathname });
    const context: RequestContext = { request, response, url, requestId };

    for (const route of routes) {
      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;
      const handler = typeof route.handle === "function" ? route.handle : route.handle[request.method as HttpMethod];
      if (!handler) {
        sendError(context, 405, "Method not allowed");
        return;
      }
      await handler(context, params);
      return;
    }
    await fallback(context, []);
  };
}

// A segment with malformed percent-encoding cannot name a resource, so the route does not match.
function matchRoute(pattern: RegExp, pathname: string): readonly string[] | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  try {
    return match.slice(1).map((segment) => decodeURIComponent(segment ?? ""));
  } catch {
    return undefined;
  }
}
