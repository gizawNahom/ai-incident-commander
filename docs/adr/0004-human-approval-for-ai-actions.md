# ADR 0004: Require explicit approval before mitigation execution

## Decision

AI output can propose actions only. A separately audited approval transition is mandatory before a simulator action runs.

## Rationale

This preserves human operational control and makes the safety model visible in the product.
