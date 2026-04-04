# Skill Authoring

## Source Contract

Every source skill lives in:

```text
skills/<skill-name>/
  SKILL.md
  references/...   optional
  scripts/...      optional
  assets/...       optional
```

`SKILL.md` must include frontmatter with exactly these source keys:

- `name`
- `description`
- `origin`

Rules:

- `name` must match the directory name.
- `description` must read like an invocation trigger, not a summary.
- `origin` records provenance such as `unified`.

## Description Rules

Write `description` for the model's routing decision.

Good patterns:

- `Use when ...`
- `Use for ...`
- `Use to ...`
- `Use before ...`
- `Use during ...`
- `Use after ...`

The description should tell the host:

- what kind of task should trigger the skill
- what decision or workflow the skill improves
- what makes it different from generic behavior

## Body Structure

The body should stay human-readable and compact.

Recommended sections:

- `Focus`, `Use when`, or `Rules`
- `Workflow`
- `Output` where relevant
- `Gotchas` for high-signal failure modes

`Gotchas` is recommended whenever the skill encodes non-obvious guardrails, common model mistakes, or workflow traps learned over time.

## Progressive Disclosure

Keep `SKILL.md` short and move heavy detail into adjacent folders:

- `references/` for source material and deeper guidance
- `scripts/` for reusable commands and helper code
- `assets/` for templates or visuals

The skill should point to these resources instead of restating them inline.

## Forbidden In Source Skills

Do not place host-specific runtime metadata in `skills/<name>/SKILL.md`.

Examples:

- `allowed-tools`
- `model`
- `effort`
- `context`
- `agent`
- `hooks`
- `paths`
- `permissionMode`
- `maxTurns`

These belong in generated artifacts or host adapters, not the shared source skill.

## Generator Responsibilities

- `scripts/build-skills.js` copies the source skill into `.agents/skills/` and generates `agents/openai.yaml`.
- `scripts/build-claude-skills.js` copies the source skill tree into `.claude/skills/`.
- `scripts/validate-skills.js` enforces the source contract and blocks host-specific frontmatter drift.

## Example

```md
---
name: investigate
description: |
  Root-cause-first debugging workflow. Use when a bug, regression, or failure
  must be explained with evidence before code changes are proposed.
origin: unified
---

# Investigate

## Rules

- no speculative fixes
- gather evidence first

## Workflow

1. Reproduce.
2. Trace execution.
3. Verify the smallest plausible root cause.

## Gotchas

- Do not jump from symptoms to patches without runtime or code evidence.
```
