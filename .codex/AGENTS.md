# Super Skills for Codex

This file supplements the repository root guidance for Codex CLI usage.

## Purpose

This repository is building a unified skill system that combines:

- gstack-style workflow execution
- ECC-style modular packaging
- Codex-first runtime structure
- security-first defaults

## Skill Discovery

Canonical skill source lives in:

```text
skills/<skill-name>/
```

Codex-facing generated skill artifacts live in:

```text
.agents/skills/<skill-name>/
```

If both exist, treat `skills/` as authored source and `.agents/skills/` as generated output.

Source skills are host-neutral. Do not add host-specific frontmatter to `skills/`; keep runtime-specific behavior in generated metadata, `.codex/`, or host adapters.

## Current Core Skill Direction

The repository is organized around a small core workflow set first:

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

Supporting skills are added modularly rather than all at once.

## Codex Runtime Expectations

### Default stance

- Prefer local repository instructions over global assumptions
- Keep the default MCP baseline lean
- Do not assume hook support
- Treat plugin adapters as optional
- Prefer explicit enablement for research, browser, and unsafe-local capabilities

### Security stance

Since Codex does not natively rely on hook-heavy enforcement in this repository:

1. Validate inputs at system boundaries
2. Never hardcode secrets
3. Prefer environment variables over custom plaintext secret files
4. Keep destructive operations explicit
5. Use lean MCP defaults and enable risky capabilities intentionally

## Multi-Agent Roles

This repository defines three initial Codex roles under `.codex/agents/`:

- `explorer` - read-only evidence gathering
- `reviewer` - correctness, regression, and security review
- `docs-researcher` - primary-source API and release-note verification

These roles are meant to support worktree-based parallel execution without overlapping ownership.

## Repository Conventions

- Keep source and generated artifacts separate
- Keep defaults safe and minimal
- Prefer deterministic scripts over hidden side effects
- Do not normalize telemetry, auto-approval, or auto-upgrade as default behavior

See also:

- [SKILL-AUTHORING.md](/Volumes/Storage/src/super-skills/docs/SKILL-AUTHORING.md)
- [AGENT-PATTERNS.md](/Volumes/Storage/src/super-skills/docs/AGENT-PATTERNS.md)
- [RUNTIME-GUIDANCE.md](/Volumes/Storage/src/super-skills/docs/RUNTIME-GUIDANCE.md)
