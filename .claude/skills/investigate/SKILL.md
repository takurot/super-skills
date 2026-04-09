---
name: investigate
description: |
  Root-cause-first debugging workflow. Use for bugs, regressions, stack traces,
  production issues, or any case where the real failure path must be understood
  before edits are proposed.
origin: unified
user-invocable: true
---

# Investigate

## Rules

- no speculative fixes
- gather evidence before changing code
- separate observations, hypotheses, and fixes

## Workflow

1. Reproduce the issue and capture exact symptoms.
2. Trace the real execution path.
3. Form the smallest plausible root-cause hypothesis.
4. Verify the hypothesis against code or runtime evidence.
5. Only then propose or implement a fix.
