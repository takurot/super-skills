---
name: dmux-workflows
description: |
  Parallel execution workflow for worktrees, sub-agents, and tmux-style task
  orchestration. Use when independent tasks can be split safely across isolated
  execution lanes.
origin: unified
user-invocable: true
---

# dmux Workflows

## Rules

- parallelize only independent tasks
- assign explicit file ownership
- merge results deliberately
- keep blocking work on the critical path local
