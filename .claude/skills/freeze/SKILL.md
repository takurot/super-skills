---
name: freeze
description: |
  Scoped-edit workflow that restricts edits to an approved directory boundary.
  Use during debugging or sensitive refactors to prevent unrelated changes from
  leaking into the session.
origin: unified
user-invocable: true
---

# Freeze

## Rules

- define an explicit allowed path
- deny edits outside the boundary
- keep the debugging or refactor scope narrow
