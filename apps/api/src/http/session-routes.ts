import { expiredSessionCookie, sessionCookie, type DemoSessionStore } from "../demo-session-store.ts";
import { isRecord, json, readJson, sendError, type Route } from "./http-kit.ts";

export function sessionRoutes(sessions: DemoSessionStore): readonly Route[] {
  return [{
    pattern: /^\/api\/session$/,
    handle: {
      GET: ({ request, response }) => {
        json(response, 200, { user: sessions.find(request.headers.cookie) ?? null, users: sessions.users() });
      },
      DELETE: ({ request, response }) => {
        sessions.end(request.headers.cookie);
        response.setHeader("set-cookie", expiredSessionCookie());
        json(response, 204, undefined);
      },
      POST: async (context) => {
        try {
          const session = sessions.start(demoUserId(await readJson(context.request)));
          if (!session) {
            sendError(context, 400, "A known demo user is required");
            return;
          }
          context.response.setHeader("set-cookie", sessionCookie(session.token));
          json(context.response, 201, { user: session.user });
        } catch (error) {
          sendError(context, 400, error instanceof Error ? error.message : "Unable to start demo session");
        }
      },
    },
  }];
}

function demoUserId(value: unknown): string {
  if (!isRecord(value) || typeof value.userId !== "string" || value.userId.trim().length === 0) {
    throw new Error("A demo user is required");
  }
  return value.userId;
}
