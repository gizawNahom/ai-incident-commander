# 0012 — Local identity and per-incident command

## Status

Accepted.

## Context

Rollback approval must be tied to a human identity, but the current MVP is
intentionally infrastructure-free and must remain easy to run locally. A
permanent global Admin role does not match normal incident response well:
command authority is normally assigned to the person leading a specific
incident.

## Decision

Provide two local demo Engineer identities through an in-memory server-side
session store. Selecting an identity creates an opaque, HTTP-only, same-site
cookie. The browser does not submit a role or actor name when approving an
action; the API resolves the actor from that session.

An authenticated Engineer may take command of an open incident. The assigned
Incident Commander alone may approve a suggested mitigation or resolve that
incident after recovery monitoring. Another authenticated Engineer can take
over command only with a non-empty reason, which is recorded with both people
in the timeline.

## Consequences

- The approval path is visibly and server-side human-controlled.
- A restart intentionally clears local sessions and command assignments.
- The supplied identities are a local demonstration aid, not access control
  suitable for a deployment exposed to untrusted users.
- A later persistence/authentication slice can replace the session store with
  real identity while preserving the incident-command authorization rule.
