# Super Skills

Super Skills is a unified skill framework for AI coding environments.

It combines:

- gstack-style high-agency workflow skills
- ECC-style modular packaging, runtime config, and MCP profiling
- security-first defaults
- shared authored skill sources with host-specific generated outputs

## What This Repository Does

This repository is not just a collection of prompts.

It provides:

- shared authored skills in `skills/`
- generated Codex-facing skill artifacts in `.agents/skills/`
- generated Claude-facing skill artifacts in `.claude/skills/`
- a repo-authored Codex baseline in `.codex/`
- a Claude adapter in `plugins/claude/`
- MCP catalog and profile definitions in `mcp/`
- installer manifests and CLI tooling in `manifests/` and `scripts/`

The design goal is simple:

- author workflow logic once
- package it differently per host
- keep defaults lean and safe

## References

This repository is derived from ideas and structures explored in:

- `gstack`: https://github.com/garrytan/gstack
- `everything-claude-code`: https://github.com/affaan-m/everything-claude-code
- `claude-code-best-practice`: a local reference knowledge base used to refine host guidance, skill authoring rules, and runtime patterns

These are references and inspirations, not bundled runtime dependencies.

## Repository Layout

- `skills/`: authored source-of-truth skills
- `.agents/skills/`: generated Codex-facing skills, committed as a fresh-checkout baseline
- `.claude/skills/`: generated Claude-facing skills, committed as a fresh-checkout baseline
- `.codex/`: repository-authored Codex runtime baseline
- `mcp/`: MCP catalog and profiles
- `plugins/`: host-specific adapters and templates
- `manifests/`: installer components, profiles, and modules
- `scripts/`: generators, validators, and installer tooling
- `docs/`: architecture, spec, plan, and security review

Generated host payloads are committed so fresh checkouts retain local skill discovery in Codex and Claude. When `skills/` changes, regenerate `.agents/skills/` and `.claude/skills/` before committing. Install-output directories such as `.claude/plugins/` and `.super-skills/` remain untracked.

## Authoring Contract

Source skills remain host-neutral and live only in `skills/`.

- allowed source frontmatter keys are `name`, `description`, and `origin`
- `name` must match the directory name
- `description` should read like a routing trigger, usually `Use when ...` or `Use for ...`
- host-specific metadata such as `allowed-tools`, `model`, `context`, `agent`, and `hooks` is intentionally blocked from source skills
- `Gotchas` sections are recommended for high-signal model failure modes

See [SKILL-AUTHORING.md](/Volumes/Storage/src/super-skills/docs/SKILL-AUTHORING.md) and [HOST-COMPATIBILITY.md](/Volumes/Storage/src/super-skills/docs/HOST-COMPATIBILITY.md).

## Core Skills

Current core workflow skills:

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

Current knowledge-pack skills:

- `tdd-workflow`
- `verification-loop`
- `coding-standards`
- `backend-patterns`
- `frontend-patterns`
- `api-design`
- `e2e-testing`
- `documentation-lookup`
- `deep-research`
- `exa-search`
- `dmux-workflows`
- `mcp-server-patterns`

## Quick Start

Build generated artifacts:

```bash
node scripts/build-skills.js
node scripts/build-claude-skills.js
```

Fresh checkouts already include the committed generated host payloads. Re-run the generators after editing `skills/` or when you want to refresh the checked-in baseline.

Validate repository state:

```bash
npm run check
```

Inspect installable targets, profiles, and components:

```bash
node scripts/list-installables.mjs
```

Preview an install:

```bash
node scripts/install-plan.mjs --profile core --target codex
node scripts/install-plan.mjs --profile core --target claude --with plugin:claude
```

Apply an install into a target root:

```bash
node scripts/install-apply.mjs --profile developer --target codex --target-root /path/to/target
node scripts/install-apply.mjs --profile core --target claude --with plugin:claude --target-root /path/to/target
```

## How To Use Skills

The usage model depends on the host.

### Codex

Codex consumes generated skills from `.agents/skills/` plus runtime defaults from `.codex/`.

Typical flow:

1. Author or update a skill in `skills/`
2. Run `node scripts/build-skills.js`
3. Install or copy the generated `.agents/skills/` output into the target Codex environment
4. Use the skill by invoking it in the normal Codex workflow for that environment

### Claude Code

Claude Code consumes generated skills from `.claude/skills/` and optional adapter files under `.claude/plugins/super-skills/`.

Typical flow:

1. Author or update a skill in `skills/`
2. Run `node scripts/build-claude-skills.js`
3. Install the Claude target with `install-apply`
4. Optionally install `plugin:claude` to get reminder-only hook templates
5. Manually merge any desired hook entries from `plugins/claude/hooks/super-skills.hooks.json`

Important:

- Claude hooks are opt-in
- The Claude adapter does not auto-enable hooks
- The Claude adapter is reminder-only and intentionally avoids auto-approval, telemetry, or hidden execution

## Real Use Cases

### 1. Failing Test Or Production Bug

Use `investigate`.

When:

- a test started failing after a refactor
- a production issue is reproducible but the cause is unclear
- you want root-cause-first debugging instead of random edits

Expected workflow:

- gather evidence first
- separate hypotheses from fixes
- avoid speculative changes

Related skills:

- `health-check`
- `verification-loop`
- `checkpoint`

### 2. Planning A New Feature

Use `plan-product` or `plan-architecture`.

When:

- you need product framing, wedge definition, UX tradeoffs, and scope control
- you need API shape, data flow, failure modes, edge cases, and testability

Example:

- `plan-product` for a new onboarding funnel or content workflow
- `plan-architecture` for a new service boundary, background job system, or API redesign

### 3. Reviewing A Risky Change

Use `review` and `security-review`.

When:

- a PR touches auth, payments, secrets, or trust boundaries
- a change is large enough that regression risk matters more than style
- you want findings-first review instead of generic feedback

Expected output:

- concrete defects and risks first
- missing tests called out explicitly
- security concerns prioritized by severity

### 4. Browser Regression Check

Use `qa-browser` or `e2e-testing`.

When:

- a UI change might have broken a critical flow
- you want report-only browser QA before deciding whether to fix
- you need a tighter feedback loop for user-facing regressions

Example:

- checkout flow verification
- settings page save flow
- onboarding or sign-in flow sanity check

### 5. Release Preparation

Use `ship-release`.

When:

- you want to verify build/test status before shipping
- you need changelog or docs synchronization
- you want release prep without auto-commit or auto-push behavior

This skill is intentionally explicit. It helps prepare the release path but does not silently mutate git state by default.

### 6. Research-Heavy Task

Use `deep-research`, `documentation-lookup`, `exa-search`, and optionally MCP research profiles.

When:

- you need official docs or current external information
- you are comparing APIs, tools, or product options
- you want a research workflow that stays separate from normal coding defaults

Example:

- compare two SDK approaches before implementation
- gather primary docs before updating an integration
- evaluate an MCP server before enabling it

## Installer Profiles

Current install profiles:

- `core`: minimal safe workflow baseline
- `developer`: core plus engineering knowledge packs, browser QA, and broader Codex support
- `security`: core plus security review capability and security MCP additions
- `research`: core plus research skills and research MCP additions

Use `install-plan` before `install-apply` when possible.

Examples:

```bash
node scripts/install-plan.mjs --profile core --target codex
node scripts/install-plan.mjs --profile developer --target codex
node scripts/install-plan.mjs --profile core --target claude --with plugin:claude
```

## MCP Profiles

The MCP catalog is intentionally separated from the default runtime baseline.

Current profiles:

- `core`: low-risk default engineering MCPs
- `research`: external docs and search
- `browser`: browser automation
- `security`: security-oriented scanning and lookup
- `unsafe-local`: localhost, broad filesystem, or other high-trust integrations

Generate MCP config fragments with:

```bash
node scripts/build-mcp-config.js --profile core
node scripts/build-mcp-config.js --profile core --profile research --format toml
node scripts/build-mcp-config.js --profile browser --format guidance
```

## Claude Adapter

`plugin:claude` installs a thin adapter into:

```text
.claude/plugins/super-skills/
```

It includes:

- adapter docs
- a hook template
- reminder-only hook scripts

It does not:

- auto-enable hooks
- auto-approve actions
- send telemetry
- rewrite git state

If you enable it, review and merge only the hook entries you actually want.

## Authoring A New Skill

Create a new directory:

```text
skills/my-skill/
  SKILL.md
```

Each `SKILL.md` should include the required frontmatter used by the generators and validators.

Source skills are intentionally host-neutral. Do not copy Claude-only command, hook, or subagent frontmatter into `skills/`.

Then run:

```bash
node scripts/validate-skills.js
node scripts/build-skills.js
node scripts/build-claude-skills.js
```

If the skill is intended to be installable by profile or target, update:

- `manifests/install-components.json`
- `manifests/install-profiles.json`
- `manifests/install-modules.json`

## Validation And Safety

Recommended validation flow:

```bash
npm run check
```

This currently covers:

- skill validation
- Codex skill generation
- Claude skill generation
- MCP validation
- config validation
- secret scanning

Security defaults are conservative:

- no telemetry by default
- no auto-approval by default
- no auto-commit or auto-push defaults
- no broad MCP enablement by default
- no plaintext secret storage scheme in repo defaults

## More Detail

- Spec: [SPEC.md](/Volumes/Storage/src/super-skills/docs/SPEC.md)
- Plan: [PLAN.md](/Volumes/Storage/src/super-skills/docs/PLAN.md)
- Architecture: [ARCHITECTURE.md](/Volumes/Storage/src/super-skills/docs/ARCHITECTURE.md)
- Skill authoring: [SKILL-AUTHORING.md](/Volumes/Storage/src/super-skills/docs/SKILL-AUTHORING.md)
- Host compatibility: [HOST-COMPATIBILITY.md](/Volumes/Storage/src/super-skills/docs/HOST-COMPATIBILITY.md)
- Agent patterns: [AGENT-PATTERNS.md](/Volumes/Storage/src/super-skills/docs/AGENT-PATTERNS.md)
- Runtime guidance: [RUNTIME-GUIDANCE.md](/Volumes/Storage/src/super-skills/docs/RUNTIME-GUIDANCE.md)
- Security review: [SECURITY-REVIEW.md](/Volumes/Storage/src/super-skills/docs/SECURITY-REVIEW.md)

## License

This project is licensed under the MIT License. See [LICENSE](/Volumes/Storage/src/super-skills/LICENSE).
