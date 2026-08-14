# ADR 0006: Start the investigator with deterministic grounded analysis

## Decision

Introduce an `IncidentInvestigator` port with a deterministic offline adapter. It receives structured incident evidence—alerts, timeline events, metric history, logs, and topology—and returns a schema-shaped analysis that separates known evidence, inference, and uncertainty.

## Rationale

The demo must be reliable without provider credentials, and every claim must be traceable to data already held by the product. Stable reasoning also makes incident behavior testable across arbitrary service names and topologies.

## Consequences

The current adapter may propose a mitigation but cannot execute it. A future LLM adapter may improve presentation or investigate questions through the same port, but it must remain constrained to supplied evidence and validated output. Human approval and simulator execution remain separate work.
