---
name: plan-architecture
description: |
  Architecture planning workflow for implementation-ready technical plans.
  Use for system design, API shape, data flow, edge cases, and testable execution
  sequencing before code changes begin.
origin: unified
user-invocable: true
---

# Plan Architecture

## Use when

- a feature spans multiple files or systems
- APIs, persistence, or async flows are involved
- execution order and risk need to be locked down

## Workflow

1. Trace impacted components and interfaces.
2. Define the data flow and failure modes.
3. Specify API, storage, and validation boundaries.
4. Break the work into dependency-aware steps.
5. Attach tests and verification to each phase.
