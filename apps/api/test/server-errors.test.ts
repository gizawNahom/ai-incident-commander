import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.ts";

type App = ReturnType<typeof createServer>;

async function withApp(run: (app: App, address: string) => Promise<void>): Promise<void> {
  const app = createServer({ autoStart: false });
  const address = await app.listen();
  try {
    await run(app, address);
  } finally {
    await app.close();
  }
}

async function signIn(address: string, userId: string): Promise<string> {
  const response = await fetch(`${address}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "Expected a session cookie");
  return cookie;
}

async function openIncident(app: App, address: string): Promise<void> {
  await fetch(`${address}/api/simulator/bad-payment-deployment`, { method: "POST" });
  app.advance();
  app.advance();
  app.advance();
}

async function postJson(url: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectError(response: Response, status: number, message?: RegExp): Promise<void> {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.ok(payload.requestId, "Expected the error to carry a request id");
  if (message) assert.match(payload.error, message);
}

test("unsupported methods are rejected on every method-restricted route", async () => {
  await withApp(async (_app, address) => {
    const routes: readonly (readonly [string, string])[] = [
      ["PUT", "/api/session"],
      ["POST", "/api/services"],
      ["POST", "/api/services/payment-service"],
      ["DELETE", "/api/alert-policies"],
      ["GET", "/api/alert-policies/latency-critical"],
      ["GET", "/api/incidents/INC-1042/investigate"],
      ["GET", "/api/incidents/INC-1042/resolve"],
      ["GET", "/api/incidents/INC-1042/command"],
      ["GET", "/api/incidents/INC-1042/actions/ACT-1/approve"],
      ["GET", "/api/simulator/bad-payment-deployment"],
      ["GET", "/api/simulator/redis-degradation"],
      ["GET", "/api/simulator/kafka-backlog"],
      ["GET", "/api/simulator/service-outage"],
      ["GET", "/api/simulator/recover"],
    ];
    for (const [method, path] of routes) {
      await expectError(await fetch(`${address}${path}`, { method }), 405, /Method not allowed/);
    }
  });
});

test("demo sessions report the signed-in user, reject unknown users, and end on sign-out", async () => {
  await withApp(async (_app, address) => {
    const anonymous = await (await fetch(`${address}/api/session`)).json();
    assert.equal(anonymous.user, null);
    assert.deepEqual(anonymous.users.map((user: { id: string }) => user.id), ["maya-chen", "daniel-okafor"]);

    await expectError(await postJson(`${address}/api/session`, { userId: "mallory" }), 400, /known demo user/);
    await expectError(await postJson(`${address}/api/session`, { userId: "  " }), 400, /demo user is required/);
    await expectError(await postJson(`${address}/api/session`, "{not json"), 400, /valid JSON/);

    const cookie = await signIn(address, "maya-chen");
    const signedIn = await (await fetch(`${address}/api/session`, { headers: { cookie } })).json();
    assert.equal(signedIn.user.name, "Maya Chen");

    const signOut = await fetch(`${address}/api/session`, { method: "DELETE", headers: { cookie } });
    assert.equal(signOut.status, 204);
    assert.match(signOut.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const afterSignOut = await (await fetch(`${address}/api/session`, { headers: { cookie } })).json();
    assert.equal(afterSignOut.user, null);
  });
});

test("request bodies must be present, valid JSON, and bounded in size", async () => {
  await withApp(async (_app, address) => {
    await expectError(await fetch(`${address}/api/alert-policies`, { method: "POST" }), 400, /JSON request body is required/);
    await expectError(await postJson(`${address}/api/alert-policies`, "{"), 400, /valid JSON/);
    await expectError(await postJson(`${address}/api/alert-policies`, { name: "x".repeat(20_000) }), 400, /too large/);
    await expectError(await postJson(`${address}/api/simulator/service-outage`, "nope"), 400);
  });
});

test("telemetry, alert policy, and incident queries reject unknown or invalid identifiers", async () => {
  await withApp(async (_app, address) => {
    const current = await fetch(`${address}/api/telemetry/current`);
    assert.equal(current.status, 200);
    await expectError(await fetch(`${address}/api/telemetry/history`), 400, /valid service/);
    await expectError(await fetch(`${address}/api/telemetry/history?service=unknown`), 400, /valid service/);

    const missingPolicy = await fetch(`${address}/api/alert-policies/POL-missing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Missing", metric: "latencyMs", comparator: "GREATER_THAN", threshold: 1, breachDurationSeconds: 0, severity: "SEV-3", enabled: true, scope: { type: "ALL_SERVICES" } }),
    });
    await expectError(missingPolicy, 404);
    const invalidPolicy = await fetch(`${address}/api/alert-policies/latency-critical`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threshold: -1 }),
    });
    await expectError(invalidPolicy, 400);

    await expectError(await fetch(`${address}/api/incidents?status=BROKEN`), 400, /valid incident values/);
    await expectError(await fetch(`${address}/api/incidents?severity=SEV-9`), 400, /valid incident values/);
    await expectError(await fetch(`${address}/api/incidents/INC-404`), 404, /Incident not found/);
    await expectError(await fetch(`${address}/api/incidents/INC-404/evidence`), 404, /evidence not found/);
    await expectError(await fetch(`${address}/api/incidents/INC-404/investigate`, { method: "POST" }), 404, /Incident not found/);
    await expectError(await fetch(`${address}/api/incidents/INC-404/actions/%E0%A4%A/approve`, { method: "POST" }), 404);
  });
});

test("incident list filters by status and severity", async () => {
  await withApp(async (app, address) => {
    await openIncident(app, address);

    const matching = await (await fetch(`${address}/api/incidents?status=DETECTED&severity=SEV-1`)).json();
    assert.deepEqual(matching.incidents.map((incident: { id: string }) => incident.id), ["INC-1042"]);
    const resolved = await (await fetch(`${address}/api/incidents?status=RESOLVED`)).json();
    assert.equal(resolved.incidents.length, 0);
  });
});

test("incident operations require a session and report command conflicts", async () => {
  await withApp(async (app, address) => {
    await openIncident(app, address);
    const maya = await signIn(address, "maya-chen");
    const daniel = await signIn(address, "daniel-okafor");

    await expectError(await fetch(`${address}/api/incidents/INC-1042/resolve`, { method: "POST" }), 401, /Sign in/);
    await expectError(await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST" }), 401, /Sign in/);
    await expectError(await fetch(`${address}/api/incidents/INC-404/command`, { method: "POST", headers: { cookie: maya } }), 404, /Incident not found/);
    await expectError(await fetch(`${address}/api/incidents/INC-404/resolve`, { method: "POST", headers: { cookie: maya } }), 404, /Incident not found/);
    await expectError(await fetch(`${address}/api/incidents/INC-1042/resolve`, { method: "POST", headers: { cookie: maya } }), 409, /Only an incident in monitoring/);

    assert.equal((await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST", headers: { cookie: maya } })).status, 200);
    await expectError(await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST", headers: { cookie: daniel } }), 409, /takeover reason is required/);
    await expectError(await postJson(`${address}/api/incidents/INC-1042/command`, { reason: 42 }, daniel), 409, /takeover reason must be text/);
  });
});

test("only the incident commander may resolve a monitored incident", async () => {
  await withApp(async (app, address) => {
    await openIncident(app, address);
    const maya = await signIn(address, "maya-chen");
    const daniel = await signIn(address, "daniel-okafor");
    await fetch(`${address}/api/simulator/recover`, { method: "POST" });
    for (let tick = 0; tick < 6; tick += 1) app.advance();

    await expectError(await fetch(`${address}/api/incidents/INC-1042/resolve`, { method: "POST", headers: { cookie: maya } }), 403, /Incident Commander must be assigned/);
    assert.equal((await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST", headers: { cookie: maya } })).status, 200);
    await expectError(await fetch(`${address}/api/incidents/INC-1042/resolve`, { method: "POST", headers: { cookie: daniel } }), 403, /Incident Commander Maya Chen/);
  });
});

test("suggested actions can be rejected with a reason and cannot be decided twice", async () => {
  await withApp(async (app, address) => {
    await openIncident(app, address);
    const maya = await signIn(address, "maya-chen");
    await fetch(`${address}/api/incidents/INC-1042/investigate`, { method: "POST" });
    const actionId = (await (await fetch(`${address}/api/incidents/INC-1042`)).json()).actions[0].id;
    const actions = `${address}/api/incidents/INC-1042/actions/${actionId}`;

    await expectError(await fetch(`${actions}/reject`, { method: "POST" }), 401, /Sign in/);
    await expectError(await fetch(`${actions}/approve`, { method: "POST", headers: { cookie: maya } }), 403, /Incident Commander must be assigned/);
    await expectError(await postJson(`${actions}/reject`, { reason: "  " }, maya), 409, /non-empty rejection reason/);
    await expectError(await fetch(`${address}/api/incidents/INC-1042/actions/ACT-missing/approve`, { method: "POST", headers: { cookie: maya } }), 404, /not found/);

    const rejected = await postJson(`${actions}/reject`, { reason: "Rollback window closed" }, maya);
    assert.equal(rejected.status, 200);
    const incident = await rejected.json();
    assert.equal(incident.actions[0].status, "REJECTED");
    assert.ok(incident.timeline.some((event: { type: string; message: string }) => event.type === "ACTION_REJECTED" && /Rollback window closed/.test(event.message)));

    assert.equal((await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST", headers: { cookie: maya } })).status, 200);
    await expectError(await fetch(`${actions}/approve`, { method: "POST", headers: { cookie: maya } }), 409, /Only a proposed action can be approved/);
    const system = await (await fetch(`${address}/api/system`)).json();
    assert.equal(system.services.find((service: { id: string }) => service.id === "payment-service")?.version, "v1.8.3");
  });
});

test("an approved rollback is recorded as failed when the defective deployment is no longer active", async () => {
  await withApp(async (app, address) => {
    await openIncident(app, address);
    const maya = await signIn(address, "maya-chen");
    await fetch(`${address}/api/incidents/INC-1042/investigate`, { method: "POST" });
    const actionId = (await (await fetch(`${address}/api/incidents/INC-1042`)).json()).actions[0].id;
    await fetch(`${address}/api/simulator/recover`, { method: "POST" });
    for (let tick = 0; tick < 4; tick += 1) app.advance();
    assert.equal((await fetch(`${address}/api/incidents/INC-1042/command`, { method: "POST", headers: { cookie: maya } })).status, 200);

    const response = await fetch(`${address}/api/incidents/INC-1042/actions/${actionId}/approve`, { method: "POST", headers: { cookie: maya } });
    assert.equal(response.status, 200);
    const incident = await response.json();
    assert.equal(incident.actions[0].status, "FAILED");
    assert.ok(incident.timeline.some((event: { type: string; message: string }) => event.type === "ACTION_FAILED" && /No active defective deployment/.test(event.message)));
  });
});

test("a malformed path encoding is treated as an unknown resource without stopping the server", async () => {
  await withApp(async (_app, address) => {
    const cookie = await signIn(address, "maya-chen");
    const malformed = "%E0%A4%A";

    await expectError(await fetch(`${address}/api/services/${malformed}`), 404);
    await expectError(await fetch(`${address}/api/alert-policies/${malformed}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), 404);
    await expectError(await fetch(`${address}/api/incidents/${malformed}/resolve`, { method: "POST", headers: { cookie } }), 404);
    await expectError(await fetch(`${address}/api/incidents/${malformed}/command`, { method: "POST", headers: { cookie } }), 404);

    const health = await fetch(`${address}/api/health`);
    assert.equal(health.status, 200);
  });
});

test("the web client entry point is served and unknown routes return 404", async () => {
  await withApp(async (_app, address) => {
    const index = await fetch(`${address}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    const styles = await fetch(`${address}/styles.css`);
    assert.match(styles.headers.get("content-type") ?? "", /text\/css/);

    await expectError(await fetch(`${address}/secrets.txt`), 404, /Route not found/);
    await expectError(await fetch(`${address}/../package.json`), 404, /Route not found/);
  });
});
