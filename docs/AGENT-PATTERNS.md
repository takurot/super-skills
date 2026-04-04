# Agent Patterns

## Summary

Agent roles in Super Skills should be narrow, evidence-oriented, and easy to compose across hosts.

The repository keeps the shared workflow logic in skills and uses host-specific agent definitions only for execution shape.

## Core Roles

### `explorer`

Use for:

- read-only codebase discovery
- evidence gathering before edits
- locating symbols, configs, and ownership boundaries

Constraints:

- no write access
- no speculative fixes
- return findings that unblock the next local step

### `reviewer`

Use for:

- correctness and regression review
- security and trust-boundary inspection
- missing test detection

Constraints:

- findings-first output
- focus on concrete defects, not style churn

### `docs-researcher`

Use for:

- primary-source API lookup
- release note verification
- version-specific behavior checks

Constraints:

- prefer official docs and primary references
- separate sourced facts from inference

## Cross-Host Mapping

| Intent | Codex shape | Claude shape | Repository stance |
|--------|-------------|--------------|-------------------|
| Read-only exploration | `.codex/agents/explorer.toml` | read-only subagent | Same intent, host-specific configuration |
| Findings-first review | `.codex/agents/reviewer.toml` | review-focused subagent | Same review contract, different runtime fields |
| Docs verification | `.codex/agents/docs-researcher.toml` | docs/research subagent | Same sourcing standard |

## Design Rules

- Prefer role-specific agents over vague personas such as "backend engineer".
- Keep ownership explicit when multiple agents run in parallel.
- Use separate contexts for test-time compute and independent review.
- Keep blocking work on the main path local unless the result is truly parallelizable.
- Treat worktrees, hooks, and preload mechanics as host-specific implementation details.
