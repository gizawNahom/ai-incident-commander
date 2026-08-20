# Roadmap Decisions

The [product specification](product-spec.md) is the source of truth for
product requirements, MVP scope, and the complete feature list. This document
only records agreed sequencing decisions that are not otherwise explicit in
the specification.

## Current sequence

1. **Configurable alert policies, in memory — completed.** The detector now
   uses a validated alert-policy model and dashboard configuration experience;
   deterministic seeded policies remain available for the demo.
2. **Incident-scoped evidence, in memory — completed.** The Incident Room and
   investigator use a bounded historical record separate from live telemetry,
   so recovery does not obscure the failure story.
3. **Behaviorally distinct simulator scenarios — completed.** Redis degradation,
   Kafka backlog, and validated targeted service outage now complement the
   existing bad-deployment scenario. Queue lag is available to alert policies.
4. **Multi-incident lifecycle management — completed.** Incidents and
   evidence records are keyed by ID; the overview exposes all unresolved
   incidents; three healthy observations move each relevant record to
   monitoring; and an engineer can explicitly resolve it. A recurrence joins
   the matching unresolved alert signature, while unrelated alert groups open
   separate records.
5. **Human-approved simulated mitigation — next.** Implement the action lifecycle
   and audit trail; approval alone may invoke a simulator command.
6. **PostgreSQL persistence.** Add durable storage only after the preceding
   product model and workflow have been validated.

## Simulator boundary note

The current simulator intentionally runs one injected failure scenario at a
time. The next lifecycle slice must support multiple incident records and
historical/monitoring state without requiring simultaneous scenario injection.
Composable simultaneous simulator failures are a later enhancement if they
become necessary to demonstrate concurrent active incidents.

## Deferred infrastructure decision

PostgreSQL remains the persistence target, but it is intentionally deferred to
preserve a fast, infrastructure-free development loop. Until then, policy,
incident, and action state is intentionally in memory and will not survive an
application restart.
