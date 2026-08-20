# 0010 — Keep service and incident history views as in-memory read models

## Status

Accepted.

## Context

The Services and Incident History screens need current service state alongside
historical incident evidence. PostgreSQL is deliberately deferred to retain the
fast, infrastructure-free development loop.

## Decision

Expose validated HTTP read models over the existing simulator and incident
manager:

- `GET /api/services` returns every service with current telemetry, health,
  active-alert count, and related-incident count.
- `GET /api/services/:id` returns one service's bounded metric history,
  observed logs and deployments, dependencies, dependents, active alerts, and
  related incident records.
- `GET /api/incidents` accepts validated optional status and severity filters.

The simulator retains a bounded stream of emitted operational logs and
deployment events. An incident is related to a service when that service is
either affected directly or appears in the incident's preserved evidence
topology. This makes dependency participants discoverable without changing the
incident's original alert evidence.

## Consequences

The browser screens are live and evidence-backed without a database. All of
these read models reset when the process restarts. PostgreSQL later replaces
their storage, not their API intent.
