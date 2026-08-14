# ADR 0007: Make Gemini-assisted investigation optional and evidence-validated

## Decision

Use the Gemini Developer API only when `AI_INCIDENT_COMMANDER_AI_PROVIDER=gemini` and `GEMINI_API_KEY` are explicitly configured. Send the model a prepared catalog of incident evidence IDs and require structured JSON. The server validates every citation, service target, and rollback recommendation before returning the analysis.

## Rationale

The AI experiment should answer whether model judgement improves an investigation without sacrificing the reliable offline demo. Gemini's free tier makes the prototype accessible, but provider availability, malformed output, unsupported citations, and unsafe rollback proposals must not interrupt incident response or mutate simulator state.

## Consequences

The default remains the deterministic investigator. If the configured provider fails or its response is invalid, the browser receives deterministic analysis with a fallback indicator. The model can only recommend `ROLLBACK_DEPLOYMENT` when it cites a matching recorded deployment. It has no tools and no path to execute simulator commands.
