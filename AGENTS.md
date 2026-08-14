# AI Incident Commander — Agent Instructions

Read `docs/product-spec.md` and `docs/architecture.md` before changing product behavior. The product is an evidence-grounded, human-controlled incident-management tool; do not replace its deterministic simulator with invented UI state or ungrounded AI output.

## Non-negotiable: test before code

For every production behavior change, write or update a failing automated test **before** writing the implementation. This applies to all agents and all feature slices.

Required loop:

1. State the behavior being changed and identify the narrowest suitable test level.
2. Add or modify the test and run it to establish a meaningful failure (RED).
3. Implement the smallest change that makes it pass (GREEN).
4. Run the focused tests, then the relevant full suite.
5. Refactor only while tests remain green.

Use domain/unit tests for lifecycle and simulator rules; integration tests for HTTP, persistence, and SSE boundaries; and browser tests for the critical demo journey. A test that only asserts markup, implementation shape, or a mock's calls is insufficient when observable behavior can be asserted instead.

Documentation-only changes, configuration-only changes with no runtime effect, and mechanical formatting changes do not require a preceding failing test. Explain any other exception in the final handoff.

## Guardrails

- Keep the application a modular monolith unless a documented decision changes that.
- Keep simulator, domain, transport, UI, persistence, and AI boundaries explicit.
- The simulator must be deterministic and independent of the LLM.
- AI outputs must be grounded in stored incident evidence and distinguish evidence, inference, and uncertainty.
- Never execute a simulated operational action until a human has explicitly approved it; record approvals and execution in the audit timeline.
- Validate external inputs, handle intentional errors, avoid `any`, and never add secrets to the repository.
- Preserve existing user changes. Do not rewrite working code unnecessarily.

## Definition of done for a slice

A slice is done only when its user-visible behavior works end-to-end, automated tests pass, error/loading/empty states are intentional where applicable, and relevant documentation/ADRs are updated.
