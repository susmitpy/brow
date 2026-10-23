---
name: browser-tester
description: Playwright MCP browser testing guide for E2E validation, API evidence collection, request/response capture, and recorded video evidence.
---

# Playwright Browser Test

Use this skill for browser validation through Playwright MCP. Keep the flow evidence-based: visible UI state plus captured backend request/response facts.

## Credential Confirmation Gate

For login flows, unless credentials were pre-approved first or stated otherwise, show the resolved values and ask the user to confirm them.

## Build Preflight

Before browser testing, make sure the app under test serves the current source.

1. Check changed files with git.
2. If changed code is served from a build step (a compiled package, a bundled library, a container image), run that build for each affected unit.
3. Restart the affected app processes or containers after rebuilding.
4. Treat stale build output as invalid test setup. Do not continue E2E until current source is what the processes serve.

## MCP Workflow

1. Check the `browser-macros` catalog for a recorded workflow before deriving selectors.
2. Start with `browser_resize`.
3. If the flow needs video evidence, run `brow video-dir <ticketId>` and `browser_start_video` before navigating (see `AGENTS.md`, **Video evidence**).
4. Navigate with Playwright MCP only after credential confirmation or documented pre-approval.
5. If certificate errors block navigation, use CDP `Security.setIgnoreCertificateErrors`.
6. Prefer accessibility snapshots for locating links, buttons, fields, tables, and dialogs.
7. Capture relevant requests and responses when validating GraphQL/REST, report, or PDF behavior.
8. Verify success with visible UI state and backend evidence.
9. Stop the recording and note it with `brow video-note`.
10. If Playwright MCP, browser, or target server is unavailable, report the blocker plainly.

## Final Evidence

Report exact evidence, including:

- URL
- User
- Flow tested
- Visible UI result
- Request variables for GraphQL/REST/report/PDF flows
- Response status and result
- Recording paths as printed by `brow video-note`
- Any blockers or skipped checks
