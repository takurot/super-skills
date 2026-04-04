# Architecture

## Overview

Super Skills separates authored workflow content from generated harness-specific artifacts.

## Layers

### 1. Source skills

`skills/<name>/SKILL.md` is the canonical source for each skill. These files are written for humans first and keep workflow semantics in one place.

Source skills stay host-neutral. Host-specific runtime metadata is not authored in `skills/`.

### 2. Generated Codex artifacts

`.agents/skills/<name>/` is generated from `skills/`. It mirrors the skill content and adds `agents/openai.yaml` metadata for Codex discovery. These generated artifacts are committed as a repository-local baseline so fresh checkouts preserve Codex skill discovery.

### 3. Generated Claude artifacts

`.claude/skills/<name>/` is generated from `skills/` for Claude Code installs. These generated artifacts are also committed so a fresh checkout preserves Claude-side skill discovery before any manual install step runs.

### 4. Runtime configuration

`.codex/` holds Codex-safe defaults, agent roles, and lean MCP enablement.

Claude guidance is authored as a template under `plugins/claude/templates/AGENTS.md` and installed to `.claude/AGENTS.md` as a target output.

### 5. Capability catalogs

`mcp/` and `plugins/` describe optional runtime expansion. They are not the source of workflow behavior.

### 6. Installation model

`manifests/` and `scripts/install-*` define how a subset of the repository is installed into a target environment.

## Skill contract

Each source skill directory may contain:

- `SKILL.md` required
- `references/` optional
- `scripts/` optional
- `assets/` optional

Required frontmatter keys in `SKILL.md`:

- `name`
- `description`
- `origin`

Additional contract rules:

- `name` matches the directory name
- `description` is trigger-oriented rather than summary-oriented
- host-specific frontmatter belongs in generated artifacts or adapters, not source skills
- `Gotchas` sections are recommended for learned failure modes

## Security model

Default behavior is conservative:

- no telemetry
- no auto-approval
- no auto-upgrade
- no broad MCP enablement
- no implicit secret file storage

## Build flow

1. Author or update `skills/<name>/SKILL.md`
2. Run `node scripts/build-skills.js`
3. Generated files appear in `.agents/skills/<name>/`
4. Run `node scripts/build-claude-skills.js`
5. Generated Claude skill copies appear in `.claude/skills/<name>/`
6. Run `node scripts/validate-skills.js`

Related docs:

- [SKILL-AUTHORING.md](/Volumes/Storage/src/super-skills/docs/SKILL-AUTHORING.md)
- [HOST-COMPATIBILITY.md](/Volumes/Storage/src/super-skills/docs/HOST-COMPATIBILITY.md)
- [AGENT-PATTERNS.md](/Volumes/Storage/src/super-skills/docs/AGENT-PATTERNS.md)
- [RUNTIME-GUIDANCE.md](/Volumes/Storage/src/super-skills/docs/RUNTIME-GUIDANCE.md)
