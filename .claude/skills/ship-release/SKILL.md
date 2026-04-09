---
name: ship-release
description: |
  Release workflow that ties verification, review, documentation updates, and PR
  preparation together. Use when work is ready to package, summarize, and move
  toward merge or deployment.
origin: unified
user-invocable: true
---

# Ship Release

## Rules

- verify before release steps
- review before push or PR
- sync docs with shipped behavior
- do not auto-commit or auto-push by default

## Workflow

1. Run verification.
2. Review the diff and release risk.
3. Update release-facing docs.
4. Prepare branch, commit message, and PR summary.
