# Host Compatibility

## Summary

Super Skills keeps workflow semantics host-neutral at the source layer and translates only the packaging layer per host.

This repository adopts useful ideas from Claude Code best practices, but it does not treat Claude-only runtime features as the source of truth for shared workflow behavior.

## Compatibility Model

| Surface | Codex | Claude Code | Repository stance |
|---------|-------|-------------|-------------------|
| Source skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` | Shared, host-neutral source of truth |
| Generated skill payload | `.agents/skills/<name>/` | `.claude/skills/<name>/` | Generated from the same source |
| Discovery metadata | `agents/openai.yaml` | Claude skill directory conventions | Host-specific metadata belongs in generated output |
| Agent roles | `.codex/agents/*.toml` | `.claude/agents/*.md` | Concepts can align, but files remain host-specific |
| Commands | Not a source concept here | `.claude/commands/` | Claude-only; keep as docs or adapter material, not shared skill source |
| Hooks | Limited / different model | `.claude/hooks/` | Host-specific operational glue, always opt-in |
| Settings and memory | `.codex/config.toml`, `AGENTS.md` | `.claude/settings.json`, `CLAUDE.md`, `.claude/rules/` | Translate principles, do not mirror raw config surfaces |

## Integration Policy

- Adopt reusable workflow ideas and authoring patterns.
- Translate host-specific concepts into host-neutral guidance when possible.
- Keep Claude-only features documented as references instead of embedding them into source skills.
- Do not import `.claude/commands/`, `.claude/hooks/`, or Claude-specific frontmatter into `skills/`.

## Claude-Only Material

The following categories are valuable reference material but stay outside the shared skill contract:

- slash command frontmatter and command menus
- hook lifecycle wiring and hook automation
- Claude-specific settings hierarchy and managed policy details
- Claude-only agent frontmatter fields that have no Codex equivalent

These may inform:

- `docs/RUNTIME-GUIDANCE.md`
- `docs/AGENT-PATTERNS.md`
- `plugins/claude/` adapter templates

They should not redefine the source skill schema.
