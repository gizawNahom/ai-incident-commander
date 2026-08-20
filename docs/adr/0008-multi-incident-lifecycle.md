# 0008 — Keep incident records independently in memory

## Status

Accepted.

## Context

The initial detector stored one incident and one evidence record. That stopped
detection after the first incident and meant a recovered incident blocked a
later, separate failure from creating a record.

## Decision

Keep incident records keyed by incident ID in the in-memory manager. An
incident enters `MONITORING` after three consecutive system observations with
none of its original policy-and-service alerts active. An engineer explicitly
resolves it through the API; resolution is added to the incident timeline.

Associate recurrence conservatively: the same source alert pair (or an alert
pair sharing a source alert) joins an unresolved incident. A pair without that
overlap creates another record, even when the two failures live in the same
larger topology.

## Consequences

Several incident records can coexist and preserve separate evidence. This is
not durable across a restart; PostgreSQL remains intentionally deferred. The
simulator still injects one failure scenario at a time, so simultaneous failure
composition is separate future work.
