# ADR 0002: Use server-sent events for initial live updates

## Decision

Expose a read-only SSE stream for telemetry and incident changes.

## Rationale

The initial product needs reliable one-way server-to-browser updates, while user commands remain ordinary HTTP requests. SSE is simple to inspect, proxy, and test. WebSockets remain an option if bi-directional collaboration later requires them.
