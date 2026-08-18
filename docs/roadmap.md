# Roadmap Decisions

The [product specification](product-spec.md) is the source of truth for
product requirements, MVP scope, and the complete feature list. This document
only records agreed sequencing decisions that are not otherwise explicit in
the specification.

## Current sequence

1. **Configurable alert policies, in memory — completed.** The detector now
   uses a validated alert-policy model and dashboard configuration experience;
   deterministic seeded policies remain available for the demo.
2. **Incident-scoped evidence, in memory — next.** Keep the historical incident
   record separate from live system telemetry so recovery does not obscure the
   failure story.
3. **Human-approved simulated mitigation.** Implement the action lifecycle
   and audit trail; approval alone may invoke a simulator command.
4. **PostgreSQL persistence.** Add durable storage only after the preceding
   product model and workflow have been validated.

## Deferred infrastructure decision

PostgreSQL remains the persistence target, but it is intentionally deferred to
preserve a fast, infrastructure-free development loop. Until then, policy,
incident, and action state is intentionally in memory and will not survive an
application restart.
