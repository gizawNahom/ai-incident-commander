# ADR 0003: Keep the simulator deterministic and independent of AI

## Decision

The simulator emits telemetry/events through a typed publisher and accepts explicit scenario commands. It does not know about UI or LLMs.

The current commands model four distinct failures: a defective deployment,
Redis degradation, Kafka consumer backlog, and a targeted outage for any known
simulated component. Each scenario produces metrics, dependency effects, and
operational logs from the same deterministic state machine. Kafka backlog also
exposes queue lag as a measurable metric, so it can be configured in an alert
policy rather than inferred only from log text.

## Rationale

Determinism makes the portfolio demo, correlation logic, and tests repeatable. The investigator analyzes emitted evidence rather than inventing system state.

Accepting the outage target as a validated service ID makes the failure model
reusable across the configured topology while keeping the simulator bounded and
safe. The HTTP layer validates external control input before issuing that
command.
