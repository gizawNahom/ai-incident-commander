# AI Incident Commander — Architecture

## Proposal

AI Incident Commander is a modular monolith built around an event-producing deterministic simulator. A browser client reads a snapshot for initial state and subscribes to server-sent events (SSE) for small live updates. The same use-case layer later persists incident state to PostgreSQL and can call an AI provider through a narrow investigator port. The application remains usable with the deterministic investigator when no provider is configured.

The implemented simulator exposes the same seam for a complete small topology:
simulator → application state → HTTP snapshot/SSE → dashboard. It has
deterministic baseline telemetry plus deployment, Redis degradation, Kafka
backlog, and targeted service-outage scenarios. Queue lag is a first-class
metric for stream scenarios and can be selected in an alert policy.

## Proposed repository structure

```text
apps/
  api/                 HTTP/SSE transport and composition root
  web/                 browser client (migrates to Next.js when UI slices need it)
  simulator/           runtime host for scenario scheduling (later)
packages/
  domain/              incidents, action approval, business invariants
  contracts/           validated API/SSE contracts (later)
  telemetry/           simulator models and correlation calculations
  ai/                  investigator port plus deterministic/provider adapters (later)
  ui/                  shared components/design tokens (later)
docs/adr/              concise architectural decisions
```

Inside `apps/api/src`, `server.ts` is only the composition root: it constructs
the simulator, stores, incident manager, and investigator, then hands them to
the HTTP adapter in `http/`. A small router owns request ids, logging,
method-not-allowed responses, and path-parameter decoding (a malformed
encoding is treated as an unknown route). Each resource has its own route
module (`session`, `telemetry`, `service`, `alert-policy`, `incident`,
`action`, `simulator`), with SSE fan-out in `event-stream.ts` and the
allow-listed web client in `static-assets.ts`.

Route handlers parse input and map outcomes to HTTP; multi-step incident
workflows live in use cases under `incidents/`. `SuggestedActionDecisions` is
the only path to an operational change: it records the Incident Commander's
approval, starts execution, calls the `MitigationExecutor` port, and records
completion or failure (including an executor error) in the audit timeline.
`IncidentInvestigation` builds the investigator context from preserved
evidence, falls back to the deterministic investigator, and records the
hypothesis and proposed action with its evidence citations. Use cases read
simulated time through a `Clock` port; the composition root adapts the
simulator to both ports. Incident operations fail with an
`IncidentOperationError` whose kind (`not-found`, `forbidden`, `conflict`)
the HTTP adapter maps to 404, 403, or 409.

## Domain model

`Incident` is the lifecycle owner: DETECTED → INVESTIGATING → IDENTIFIED → MITIGATING → MONITORING → RESOLVED. It records affected services, alerts, timeline events, hypotheses, actions, and audit events.

`SuggestedAction` is a separate safety-governed entity: PROPOSED → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED. It records its target service, source and rollback versions, evidence citations, risk, actor, decision reason, timestamps, and outcome. Only the approval use case invokes a simulator command; a public execute attempt is rejected. The initial rollback executor validates that the currently injected defective deployment matches the action before it starts deterministic recovery. `Service`, `Deployment`, `Alert`, `MetricSample`, and `LogEntry` provide evidence; their events feed incident detection and the grounded investigator context.

`AlertPolicy` is a reusable detector configuration: scope (all or selected
services), metric, comparator, threshold, breach duration, severity, and
enabled state. The in-memory policy store validates API input and supplies the
incident manager; each policy can create a separate alert instance per matching
service. This state is deliberately not durable until the later PostgreSQL
slice.

The incident manager also exposes a small detector-status read model: no active
alerts, active alerts waiting for correlation, or an incident created. The
dashboard reads this model alongside its SSE stream so it can explain why a
single policy's alerts have not opened an incident.

`IncidentEvidence` is an in-memory read model kept separately from the live
simulator snapshot. It captures the dependency neighborhood, deployment and
log evidence, alerts, and bounded metric histories at incident creation, then
continues capturing relevant events while the incident remains open. The AI
investigator consumes this record, so recovery cannot replace its evidence with
healthy live telemetry.

The Services and Incident History screens use explicit in-memory read models:
the simulator retains bounded emitted deployment/log history, while the
incident manager supplies active alerts and preserved incident context.
`GET /api/services`, `GET /api/services/:id`, and filtered `GET /api/incidents`
compose those sources without inventing UI state. A service is related to an
incident if it was directly affected or appears in that incident's preserved
dependency context. This is intentionally ephemeral until the PostgreSQL slice.

`IncidentManager` keeps incident records independently in memory rather than
holding one global active incident. A record moves to `MONITORING` after three
consecutive snapshots show none of its source alert conditions active; an
engineer then explicitly resolves it. If the same policy-and-service alert pair
returns before resolution, that record moves back to `INVESTIGATING`. This
conservative correlation signature avoids merging a separate failure merely
because it shares a broad topology with another incident.

The current identity slice is deliberately local and in memory: a user chooses
one of the supplied demo Engineer identities, and the server issues an opaque,
HTTP-only session cookie. It is not an enterprise authentication solution and
does not attempt to store passwords. Incident command is an assignment on each
open incident, rather than a permanent global role. Only the server-identified
Engineer currently assigned as that incident's commander may approve an action
or resolve the incident. Another authenticated Engineer can take over command
only with a recorded reason. All command, approval, and resolution events
retain the actor's name in the timeline. Sessions and command assignments reset
with the in-memory application, pending the future PostgreSQL identity slice.

Business-level acceptance coverage lives in executable Gherkin feature files
under `apps/acceptance/features`. The shared flagship journey runs through an
`IncidentCommanderDriver` boundary: the API driver gives fast feedback against
a fresh real HTTP server and deterministic simulator, while the Playwright
browser driver clicks only visible controls and observes rendered UI state.
Transport-safety scenarios that deliberately bypass the UI remain API-only.
The browser runner uses a faster test-only simulator clock; production retains
its two-second update interval.

## MVP slices

1. **Walking skeleton (this change):** live API Gateway latency from deterministic simulator to dashboard via SSE.
2. Distributed simulator: services, dependencies, baseline telemetry, and all
   required failure scenarios. **Completed.**
3. Detection: alerts, incident lifecycle, timeline, and audit stream.
4. Incident Room: topology, evidence, metrics, logs, and timeline.
5. Grounded investigator: deterministic analysis first; optional Gemini Developer API adapter behind the same port. Provider output is schema-shaped and locally checked against the evidence catalog; absent, failed, or invalid provider output falls back to deterministic analysis.
6. Human approval: proposed mitigations, approval trail, and simulated execution. **Completed for deployment rollback using the demo Engineer identity.** RBAC remains a later identity slice.
7. Deterministic demo story. Browser end-to-end coverage is complete for the
   flagship release-incident journey.
8. PostgreSQL persistence, Next.js UI migration, polish, and deployment.

## First vertical-slice acceptance criteria

Given the simulator is running normally, when a browser opens the dashboard, then it receives a current API Gateway latency reading. When the simulator advances, then subscribed browsers receive a new telemetry event without reloading.
