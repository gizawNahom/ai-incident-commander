# 0009 — Execute simulator mitigation only through action approval

## Status

Accepted.

## Context

The investigator could ground a rollback recommendation in incident evidence,
but its response was transient text and the dashboard’s recovery control could
change the simulator without an incident decision record.

## Decision

Represent a rollback recommendation as an incident-owned `SuggestedAction`.
It records the target service, source and target versions, evidence citations,
risk, actor, decision reason, timestamps, and outcome. Its state machine is:

```text
PROPOSED → APPROVED → EXECUTING → COMPLETED / FAILED
         └→ REJECTED
```

The API exposes approval and rejection decisions. It deliberately rejects a
direct execute request. Approval is the sole orchestration path: it records
approval, moves the action into execution, calls the simulator rollback port,
and records completion or failure. The simulator validates that the proposed
target/version pair matches the active injected deployment before recovery
starts.

## Consequences

The Incident Room can show a durable in-memory audit trail and safely reflect
live action progress through SSE incident updates. The demo identity is
`Engineer (demo)` until the later identity/RBAC slice. Direct simulator recovery
remains a chaos/reset control outside this operational approval workflow; it is
not the flagship mitigation path. Actions remain in memory until PostgreSQL is
introduced.
