# Super Skills for Claude Code

This file provides the Claude Code view of the unified skill repository.

## Purpose

This repository keeps workflow logic shared while adapting packaging per host.

- Shared authored skill source lives in `skills/`
- Claude-ready skill payloads live in `.claude/skills/`
- Codex-ready skill payloads live in `.agents/skills/`

## Claude Skill Layout

Claude Code should consume skills from:

```text
.claude/skills/<skill-name>/SKILL.md
```

Those skill directories are generated from the shared `skills/` source tree. Do not edit generated Claude skill copies directly.

Source skills stay host-neutral. Claude-only command, hook, and agent metadata should not be authored in `skills/`.

## Current Skill Coverage

Core workflow skills:

- `plan-product`
- `plan-architecture`
- `investigate`
- `review`
- `security-review`
- `qa-browser`
- `ship-release`
- `health-check`
- `checkpoint`
- `careful`
- `freeze`
- `guard`

Knowledge-pack skills are installed alongside the core set unless profile selection narrows them.

## Security Stance

- Keep hooks opt-in
- Do not assume telemetry
- Do not auto-approve actions
- Keep destructive actions explicit
- Prefer environment variables over plaintext secret files

## Host Boundary

Claude-specific adapter logic should stay thin. Workflow semantics belong in shared skills, manifests, and docs, not in hidden host glue.

Claude-only best-practice material can inform:

- adapter templates
- runtime guidance docs
- host-specific install steps

It should not redefine the shared source skill contract.
