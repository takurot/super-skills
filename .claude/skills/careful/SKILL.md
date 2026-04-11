---
name: careful
description: |
  Destructive-action warning workflow. Use when operations may delete files,
  rewrite git history, discard changes, or modify high-risk infrastructure and
  data paths.
origin: unified
user-invocable: true
---

# Careful

## Guard

Warn before:

- recursive delete
- force push
- reset hard
- destructive database commands
- destructive infra commands
