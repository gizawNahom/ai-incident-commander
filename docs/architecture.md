# AI Incident Commander — Architecture

## Proposal

AI Incident Commander is a modular monolith built around an event-producing deterministic simulator. A browser client reads a snapshot for initial state and subscribes to server-sent events (SSE) for small live updates. The same use-case layer later persists incident state to PostgreSQL and can call an AI provider through a narrow investigator port. The application remains usable with the deterministic investigator when no provider is configured.

This first slice deliberately proves the end-to-end seam: simulator → application state → HTTP snapshot/SSE → dashboard. It has one simulated service and one changing latency metric.

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

## Domain model

`Incident` is the lifecycle owner: DETECTED → INVESTIGATING → IDENTIFIED → MITIGATING → MONITORING → RESOLVED. It records affected services, alerts, timeline events, hypotheses, actions, and audit events.

`SuggestedAction` is a separate safety-governed entity: PROPOSED → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED. Only an approved action can invoke a simulator command. `Service`, `Deployment`, `Alert`, `MetricSample`, and `LogEntry` provide evidence; their events feed incident detection and the grounded investigator context.

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

## MVP slices

1. **Walking skeleton (this change):** live API Gateway latency from deterministic simulator to dashboard via SSE.
2. Distributed simulator: services, dependencies, baseline telemetry, and failure scenarios.
3. Detection: alerts, incident lifecycle, timeline, and audit stream.
4. Incident Room: topology, evidence, metrics, logs, and timeline.
5. Grounded investigator: deterministic analysis first; optional Gemini Developer API adapter behind the same port. Provider output is schema-shaped and locally checked against the evidence catalog; absent, failed, or invalid provider output falls back to deterministic analysis.
6. Human approval: proposed mitigations, RBAC, approval trail, simulated execution.
7. Deterministic demo story and end-to-end coverage.
8. PostgreSQL persistence, Next.js UI migration, polish, and deployment.

## First vertical-slice acceptance criteria

Given the simulator is running normally, when a browser opens the dashboard, then it receives a current API Gateway latency reading. When the simulator advances, then subscribed browsers receive a new telemetry event without reloading.
