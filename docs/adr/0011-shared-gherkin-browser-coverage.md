# 0011 — Run the flagship Gherkin journey through API and browser drivers

## Status

Accepted.

## Context

The existing Gherkin suite exercised the real API, simulator, and incident
manager, but did not prove that an engineer could navigate and complete the
same workflow in the browser. Duplicating the incident story in API and browser
feature files would let the specifications drift apart.

## Decision

Keep business-language shared features under `apps/acceptance/features` and
execute them through an `IncidentCommanderDriver` interface:

- `ApiIncidentCommanderDriver` calls the public HTTP API for fast feedback.
- `BrowserIncidentCommanderDriver` starts a fresh real server and uses
  Playwright to operate only visible browser controls and rendered evidence.

`npm run test:acceptance` selects the API driver. `npm run test:e2e` selects
the browser driver for the shared feature. API-only safety scenarios, such as
attempting the forbidden direct action-execution route, remain API tests.

The browser driver uses a one-second simulator tick solely in its isolated test
server so that it observes the same deterministic sequence quickly. Production
continues to update every two seconds. On a browser failure the driver writes a
full-page screenshot under `/tmp/ai-incident-commander-e2e`.

## Consequences

The flagship story has one executable business specification and two levels of
confidence: fast integrated feedback plus real user-visible verification.
Playwright and Chromium are development dependencies. Future critical UI
journeys should reuse the driver boundary rather than duplicate wording or
silently use direct API calls from browser scenarios.
