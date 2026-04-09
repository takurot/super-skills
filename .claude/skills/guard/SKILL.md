---
name: guard
description: |
  Combined safety workflow that applies destructive-command warnings and scoped
  edit boundaries together. Use for high-risk tasks where both command safety
  and edit containment matter.
origin: unified
user-invocable: true
---

# Guard

## Combines

- `careful`
- `freeze`

## Use when

- production-like systems are involved
- risky migrations or debugging are in progress
- edits must stay inside a single bounded area
