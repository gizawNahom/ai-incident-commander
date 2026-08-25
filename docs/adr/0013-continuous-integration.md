# 0013 — Verify every change in GitHub Actions

## Status

Accepted.

## Context

The project has local static checks, API acceptance coverage, and a real
Playwright browser journey, but their execution depended on each developer's
machine. A portfolio project needs a visible, repeatable signal that changes
continue to satisfy its quality gates.

## Decision

GitHub Actions runs one `Verify` workflow for pull requests targeting `main`,
pushes to `main`, and manual dispatches. It uses Node.js 24, installs the lock
file exactly with `npm ci`, installs Chromium for Playwright, then runs:

1. `npm run check`
2. `npm test`

The workflow has read-only repository permissions and does not receive AI or
deployment credentials. If the browser journey fails, its captured screenshot
directory is retained as a short-lived workflow artifact. Newer runs for the
same ref cancel an obsolete in-progress run.

## Consequences

`main` and pull requests receive the same core checks used locally, including
the visible-browser incident journey. The workflow deliberately performs no
deployment; public hosting remains a separate decision. Contributors need no
cloud credentials to run or validate the application.
