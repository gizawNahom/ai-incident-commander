# ADR 0001: Start as a modular monolith

## Decision

Ship one TypeScript process with clear domain, telemetry, transport, UI, and AI boundaries.

## Rationale

The product's distributed system is simulated. Splitting the product itself into services would add operational complexity without increasing the credibility of the incident investigation story.
