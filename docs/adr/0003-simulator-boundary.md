# ADR 0003: Keep the simulator deterministic and independent of AI

## Decision

The simulator emits telemetry/events through a typed publisher and accepts explicit scenario commands. It does not know about UI or LLMs.

## Rationale

Determinism makes the portfolio demo, correlation logic, and tests repeatable. The investigator analyzes emitted evidence rather than inventing system state.
