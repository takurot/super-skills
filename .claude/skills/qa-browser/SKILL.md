---
name: qa-browser
description: |
  Browser-centric QA workflow for user flows, regressions, and bug reproduction.
  Use for end-to-end checking, report-only QA, or iterative test-and-fix loops
  around visible product behavior.
origin: unified
user-invocable: true
---

# QA Browser

## Modes

- report-only
- test-and-fix
- regression verification

## Workflow

1. Identify the target flow and environment.
2. Exercise the flow in a real browser.
3. Capture failures with concrete repro steps.
4. If fixing is allowed, patch and re-verify.
5. End with a ship-readiness summary.
