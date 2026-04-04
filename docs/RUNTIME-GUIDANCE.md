# Runtime Guidance

## Instructions And Memory

Keep repository-level instructions lean and durable.

Guidelines:

- keep top-level `AGENTS.md` focused on stable project rules
- place host-specific runtime guidance in `.codex/` or `plugins/claude/`
- prefer smaller, closer instruction files for component-specific behavior
- avoid burying deterministic policy in long narrative instructions when config can enforce it

The operational lesson from Claude-style memory also applies here:

- shared root guidance should load everywhere
- deeper, component-specific guidance should stay local to the relevant area
- do not overload one giant instruction file with every edge case

## Permissions And Sandboxing

Default stance:

- safe by default
- explicit escalation
- no auto-approval assumptions

Use config for deterministic behavior where possible:

- sandbox mode
- approval policy
- MCP enablement
- agent role defaults

Do not rely on prose alone for behavior that a host can enforce structurally.

## Context Management

Use a deliberate context strategy:

- plan before broad implementation
- compact or reset context when switching tasks
- start a fresh session when the task boundary changes materially
- use sub-agents or parallel roles to isolate side investigations

## Host-Specific Notes

Claude Code references in `claude-code-best-practice` informed these principles:

- skill descriptions should be routing triggers
- progressive disclosure beats giant inline prompts
- component-local memory files scale better than one monolith
- hooks and commands are useful, but remain host-specific and opt-in here

Codex-specific defaults remain anchored in `.codex/config.toml` and `.codex/AGENTS.md`.
