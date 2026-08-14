# ADR 0005: Use policy-driven alerting and topology-based incident correlation

## Decision

Evaluate reusable metric policies against every observed service. Create an incident only when alerts from different policies occur within a bounded time window and their services are connected in the observed dependency graph.

## Rationale

The application must work for arbitrary systems, not only the seeded Payment/Checkout demonstration. Policies make thresholds configurable; topology and time make grouping evidence-based while avoiding the merger of unrelated alerts. Deployment and log evidence is attached using the same correlation window and graph relationship.

## Consequences

The current in-memory implementation ships two default policies: latency above 1,000 ms and error rate above 10%. Future persistence can store policies, service-specific overrides, alert resolution, and sequential incident IDs without changing the correlation model.
