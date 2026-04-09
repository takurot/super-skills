# Super Skills Unified Spec

## Purpose

Build a unified skill framework in this repository by combining the strongest workflow patterns from `ref/gstack` and the strongest modular packaging, Codex, MCP, and multi-agent patterns from `ref/everything-claude-code`.

The result should be:

- Workflow-strong like gstack
- Modular and installable like ECC
- Codex-first in structure
- Security-first by default
- Extensible to plugins, MCP profiles, and multi-agent roles

## Source Inputs

Primary references:

- `ref/gstack`
- `ref/everything-claude-code`

Primary integration surfaces:

- `skills/`
- `.agents/skills/`
- `.codex/`
- `mcp/`
- `plugins/`
- `manifests/`
- `scripts/`

## Design Principles

### 1. Workflow density over catalog sprawl

Adopt gstack's strongest end-to-end workflows for planning, debugging, QA, review, security, and release operations.

### 2. Modular packaging over monolith

Adopt ECC's modular manifests, install profiles, Codex config structure, and agent role layout so the system can be installed in slices instead of as an all-or-nothing bundle.

### 3. Codex-first artifact model

The repository should treat human-authored `skills/` as the source of truth and generate Codex-facing `.agents/skills/` metadata from that source.

The same shared `skills/` source should also be installable for Claude Code without forking workflow content. Claude support should package shared skills into a Claude-native directory layout rather than maintaining a second authored skill tree.

### 4. Security-first defaults

No auto-executing telemetry, auto-upgrade, auto-commit, auto-routing injection, or broad MCP enablement should be enabled by default.

### 5. Lean defaults, explicit expansion

The default install should be small and safe. Research, browser automation, external APIs, and host-specific plugins should be opt-in profiles.

## What To Adopt From gstack

Adopt these workflow ideas and translate them into unified skills:

- `office-hours`
- `plan-ceo-review`
- `plan-design-review`
- `plan-eng-review`
- `investigate`
- `review`
- `qa`
- `qa-only`
- `ship`
- `document-release`
- `health`
- `cso`
- `careful`
- `freeze`
- `guard`
- `checkpoint`

Adopt these implementation concepts:

- Template or generated-skill pipeline
- Strong skill descriptions and invocation intent
- Safety boundaries for destructive commands and scoped edits
- End-to-end browser-centric QA workflows
- Release workflow that ties verification, review, docs, and PR flow together

Do not adopt as default behavior:

- Telemetry preambles
- Upgrade-check preambles
- Auto-upgrade behavior
- Automatic CLAUDE.md routing injection
- Skill-side automatic commits
- Saving secrets to custom plaintext files when environment variables suffice

## What To Adopt From ECC

Adopt these structural patterns:

- `.codex/config.toml` baseline
- `.codex/agents/*.toml` role definitions
- `.agents/skills/<skill>/SKILL.md` plus `agents/openai.yaml`
- `manifests/install-components.json`
- `manifests/install-profiles.json`
- MCP cataloging and profile thinking
- Research and external-tool skills
- Codex-oriented AGENTS guidance

Adopt these skill families as modular knowledge packs:

- `tdd-workflow`
- `security-review`
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

Adopt these platform patterns selectively:

- Multi-agent roles: `explorer`, `reviewer`, `docs-researcher`
- Lean Codex MCP baseline
- Install profiles such as `core`, `developer`, `security`, `research`

Do not adopt as default behavior:

- Broad default MCP enablement
- Auto-approval behavior from OpenCode plugins
- Hook-heavy runtime assumptions that do not map cleanly to Codex
- Large default install surface

## Unified Repository Model

### Source of truth

Author canonical skill content in:

```text
skills/<skill-name>/
  SKILL.md
  assets/...            optional
  references/...        optional
  scripts/...           optional
```

### Generated artifacts

Generate Codex-facing artifacts in:

```text
.agents/skills/<skill-name>/
  SKILL.md
  agents/openai.yaml
```

Generate Claude-facing artifacts in:

```text
.claude/skills/<skill-name>/
  SKILL.md
  assets/...            optional
  references/...        optional
  scripts/...           optional
```

### Runtime config

Keep Codex runtime defaults in:

```text
.codex/
  AGENTS.md
  config.toml
  agents/
    explorer.toml
    reviewer.toml
    docs-researcher.toml
```

Keep Claude runtime guidance in:

```text
.claude/
  AGENTS.md
  skills/
```

### MCP layout

Define MCP in:

```text
mcp/
  catalog.json
  profiles/
    core.json
    research.json
    browser.json
    security.json
    unsafe-local.json
```

### Plugin layout

Define host-specific adapters in:

```text
plugins/
  README.md
  claude/
  opencode/
  cursor/
```

### Install and module manifests

Define selective installation in:

```text
manifests/
  install-components.json
  install-profiles.json
  install-modules.json
```

## Installer Specification

### Installer goals

The repository must support installing a safe subset of the unified system into a target environment without copying the entire repository by default.

The installer must support:

- dry-run planning
- profile-based install
- component-based install
- target-specific install
- idempotent re-run
- validation before apply
- explicit opt-in for risky capabilities

### Installer surfaces

The system should expose:

- `scripts/install-plan.*`
- `scripts/install-apply.*`
- `scripts/install-validate.*`
- `scripts/list-installables.*`

If a single entrypoint is added later, it should wrap these functions instead of replacing them.

### Installer inputs

The installer must accept:

- `--profile <name>`
- `--with <component>`
- `--without <component>`
- `--target <target>`
- `--dry-run`
- `--json`
- `--config <path>`

Optional future inputs:

- `--force`
- `--upgrade`
- `--repair`

### Installer outputs

The planner must produce:

- selected modules
- selected components
- skipped modules
- target paths
- files to be copied or generated
- files that would be overwritten
- required secrets or environment prerequisites
- risk notes for enabled MCP or plugin capabilities

### Installer targets

The installer should support at least these targets:

- `codex`
- `claude`
- `opencode`
- `cursor`

The first implementation must fully support `codex` and `claude`. Other targets may remain scaffold-level initially.

### Installer profiles

The first supported install profiles should be:

- `core`
- `developer`
- `security`
- `research`

Profile meaning:

- `core`: minimal safe workflow baseline
- `developer`: core plus main engineering skills and Codex runtime
- `security`: core plus security review, scanning, and guarded workflows
- `research`: core plus documentation, Exa, and deep research capabilities

### Installer components

Components should map to user-meaningful units rather than raw directories.

Minimum component families:

- `baseline:*`
- `workflow:*`
- `capability:*`
- `agent:*`
- `mcp:*`
- `plugin:*`
- `target:*`

Examples:

- `baseline:skills`
- `baseline:codex`
- `workflow:review`
- `workflow:qa`
- `capability:research`
- `capability:security`
- `mcp:core`
- `mcp:research`
- `plugin:opencode`
- `target:codex`

### Installer behavior rules

The installer must:

- be idempotent on repeated runs
- avoid mutating unrelated files
- separate source assets from generated assets
- refuse ambiguous installs
- fail fast on invalid manifests
- warn before overwriting user-edited files
- distinguish authored files from generated files

### Generated vs authored file handling

The installer must treat these as generated:

- `.agents/skills/**`
- generated metadata
- generated target config fragments

The installer must treat these as authored:

- `skills/**`
- `docs/**`
- `manifests/**`
- most `plugins/**`
- most `mcp/**`

Generated files may be safely rebuilt. Authored files must not be silently replaced.

### Installer security rules

The installer must never:

- enable telemetry by default
- inject live secrets into tracked files
- enable high-risk MCP servers by default
- install auto-approval behavior by default
- enable plugin hooks with side effects by default
- normalize plaintext secret files as the primary secret path

The installer must clearly label:

- which capabilities require secrets
- which capabilities broaden network access
- which capabilities execute local commands automatically
- which capabilities are experimental or unsafe-local

### Installer validation rules

Before apply, the installer must validate:

- manifests are internally consistent
- requested profile exists
- requested components exist
- target is supported
- required generated assets are buildable
- unsafe components are explicitly requested

### Installer state tracking

The installer should maintain install state so future runs can:

- detect what was previously installed
- compute upgrade or repair plans
- avoid duplicate writes
- show drift between installed and desired state

State may live under a target-specific metadata path, but must not contain secrets.

### Installer documentation requirements

The repository must document:

- supported targets
- supported profiles
- install examples
- dry-run examples
- how to remove or repair an install
- how generated artifacts are rebuilt
- how risky components are enabled explicitly

## Unified Skill Set For v1

### Core workflow skills

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

### Core knowledge and support skills

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

### Skill mapping notes

- `plan-product` merges `office-hours`, `plan-ceo-review`, and `plan-design-review`
- `plan-architecture` merges `plan-eng-review`, `api-design`, and `backend-patterns`
- `security-review` merges gstack `cso` depth with ECC `security-review` checklisting
- `qa-browser` merges gstack browser QA with ECC Playwright-oriented testing
- `ship-release` merges gstack `ship` and `document-release` with ECC verification discipline

## Security Requirements

### Default safety posture

The unified system must default to:

- No telemetry enabled
- No networked analytics
- No auto-upgrade
- No auto-commit
- No auto-approve
- No broad MCP surface
- No secret placeholders committed into active config files

### Allowed default MCP baseline

Only lean, broadly useful MCP entries should be enabled by default:

- GitHub
- Context7
- Exa
- Memory
- Playwright
- Sequential Thinking

All other MCP servers must be cataloged but disabled by default.

### Destructive-action controls

The system must preserve guarded workflows for:

- recursive delete
- force push
- reset hard
- discard checkout or restore
- destructive database commands
- destructive infra commands

### Secret handling

The system must prefer:

1. Environment variables
2. User-managed secret stores
3. Explicit local config ignored by git only when necessary

The system must not normalize custom plaintext secret files as the primary recommended path.

### External execution controls

Any plugin, hook, or MCP behavior that:

- auto-runs commands
- opens browsers
- sends telemetry
- injects routing docs
- modifies git state
- broadens permissions

must be opt-in and clearly documented.

## MCP Specification

### Catalog fields

Each MCP server entry in `mcp/catalog.json` should include:

- `id`
- `description`
- `transport`
- `command` or `url`
- `args`
- `env`
- `risk_level`
- `requires_secrets`
- `default_enabled`
- `profiles`
- `notes`

### Profile intent

- `core`: safe default local engineering
- `research`: Exa, documentation, crawling, external research
- `browser`: Playwright and browser-task support
- `security`: security scanners and review helpers
- `unsafe-local`: experimental, localhost, or high-trust services

## Plugin Specification

Plugins are host adapters, not the source of truth for behavior.

Requirements:

- Keep plugin logic thin
- Do not encode core workflow semantics only inside plugins
- Any hook-like behavior must have a Codex-safe fallback path
- Default plugin mode is disabled or minimal

## Multi-Agent Specification

Carry forward ECC's role split:

- `explorer`: read-only evidence gathering
- `reviewer`: correctness, regression, and security review
- `docs-researcher`: primary-doc verification

These roles should exist in `.codex/agents/` and be referenced from `.codex/config.toml`.

## Build and Validation Requirements

The repository should provide scripts to:

- validate source skills
- generate `.agents/skills/`
- validate generated metadata
- validate manifests
- validate MCP catalog shape
- run secret scanning
- run dependency audit

## Non-Goals For v1

These should not be part of the first implementation slice:

- importing all 116 ECC skills
- porting all gstack skills
- supporting every external host equally
- preserving legacy hook parity
- implementing remote telemetry
- implementing browser extensions
- implementing full install automation before core structure is stable

## Success Criteria

The unified repository is successful when:

- Core workflow skills exist in `skills/`
- Codex-facing generated skills exist in `.agents/skills/`
- `.codex/` provides a lean working baseline
- MCP catalog and profiles are explicit and risk-labeled
- Plugin adapters are opt-in
- Security defaults are safer than both source repos
- The repo supports phased expansion without restructuring

## Skill Build Pipeline Enhancements (v1.1)

The core skill generation pipeline exists but requires the following additions to be complete.

### Claude Frontmatter Injection

`scripts/build-claude-skills.js` currently copies `SKILL.md` verbatim from `skills/` into `.claude/skills/`.
Claude Code requires `user-invocable: true` in the frontmatter to surface a skill as an invocable slash command.
Because source skills must remain host-neutral (enforced by `validateSourceSkillMetadata`), this field must be
injected during the Claude-facing build step.

Requirements:

- After extracting frontmatter from the source skill, inject `user-invocable: true` before writing to `.claude/skills/<name>/SKILL.md`
- The injection must be applied to every skill directory processed by `build-claude-skills.js`
- The build must still fail if the source skill already declares any host-specific frontmatter key (existing rule preserved)
- A helper function `injectClaudeFrontmatter(content)` must be extracted into `scripts/lib/skill-metadata.js` and covered by unit tests

### Drift Detection

After a skill is edited in `skills/`, the generated artifacts in `.agents/skills/` and `.claude/skills/` may become
stale without any visible signal. The `check` script currently rebuilds everything but does not detect whether
previously generated artifacts have drifted from their source.

Because the two generators apply different transformations, drift must be detected differently per target:

- `build-skills.js` copies `SKILL.md` verbatim into `.agents/skills/<name>/SKILL.md`. Drift is detected by
  comparing the SHA-256 of the source file against the SHA-256 of the corresponding `.agents/` file directly.
- `build-claude-skills.js` injects `user-invocable: true` before writing to `.claude/skills/<name>/SKILL.md`,
  so the generated content intentionally differs from the source. Drift must be detected by rendering the
  expected output in memory using the same `injectClaudeFrontmatter` logic and comparing that rendered
  result against the file on disk. The source file content is NOT compared verbatim against the Claude target file.
- `build-skills.js` also writes `agents/openai.yaml` derived from skill metadata, not copied from source.
  Drift for this file is detected by regenerating the expected YAML string from the source frontmatter using
  the same `buildOpenAIYaml` logic and comparing against the file on disk.

A new script `scripts/check-drift.js` must:

- For each skill directory in `skills/`:
  - Check `.agents/skills/<name>/SKILL.md` via direct content hash comparison (verbatim copy)
  - Check `.agents/skills/<name>/agents/openai.yaml` via regenerated expected content comparison
  - Check `.claude/skills/<name>/SKILL.md` via rendered-in-memory expected content comparison
  - Report each drifted or missing artifact by name and artifact path
- Support `--json` output mode
- Exit with code 0 when no drift is found, code 1 when drift is detected
- Be invoked at the start of the `check` npm script so drift is caught before build runs

The script must not write any files. It is a read-only consistency check.

## Installer Enhancements (v1.1)

The installer pipeline (`install-plan.mjs`, `install-apply.mjs`, `install-lib.mjs`) is implemented and functional.
The following additions are required to support safe re-installation and operational visibility.

### Force Override Flag

`install-apply.mjs` refuses to overwrite authored files that have been locally modified, which is correct default
behavior. However, there is no escape hatch for re-installation or upgrade scenarios.

A `--force` flag must be added that:

- Allows `copyFileSafely` to overwrite authored files even when content differs
- Does not change behavior for generated files (always overwritten regardless of `--force`)
- Is parsed in `install-lib.mjs > parseArgs` and forwarded to apply operations
- Is surfaced in dry-run output when active: `Force mode: authored file overwrites enabled`

### Install Status Command

There is no command to verify the health of an existing install without re-running the full apply.

A new script `scripts/install-status.mjs` must:

- Accept `--target <codex|claude>`, `--target-root <path>`, and `--json` flags
- Read the state file written by `install-apply.mjs` at `.super-skills/install-state/<target>.json`
- Report `NOT INSTALLED` if the state file does not exist
- Expand each recorded module operation from `state.pendingOperations` into concrete expected file paths,
  then verify that each expanded path exists under `targetRoot`. This is required because `state.targetPaths`
  records only top-level directories (e.g. `.claude/skills`), which may exist even when their contents are
  missing or incomplete. Using `pendingOperations` to expand to actual expected files provides a more
  accurate health signal.
- Exit with code 0 when all expanded paths exist, code 1 when any are missing
- Avoid content hash comparison in v1.1 (path presence check is sufficient for this iteration)

Note: if `state.pendingOperations` does not provide sufficient resolution to enumerate individual files
(e.g. for directory-copy operations), the script may fall back to checking that each `targetPath` entry
is a non-empty directory rather than just checking existence.

### Convenience Entry Points

Users must know to run `node scripts/install-apply.mjs` with explicit flags, which requires knowledge of the
repository internals. The following npm scripts must be added to `package.json` to expose the most common operations:

- `install:claude` — applies `developer` profile to `--target-root ~`
- `install:codex` — applies `developer` profile to `--target-root ~`
- `install:plan:claude` — dry-run plan for `developer` profile against Claude target
- `install:plan:codex` — dry-run plan for `developer` profile against Codex target
- `install:status:claude` — runs `install-status.mjs --target claude` against `--target-root ~`
- `install:status:codex` — runs `install-status.mjs --target codex` against `--target-root ~`

These scripts do not replace the low-level CLI; they are aliases for the most common invocations.

### Non-Goals For Installer v1.1

- `--upgrade` and `--repair` modes (require drift detection per-file; deferred to v1.2)
- Content hash comparison in `install-status.mjs` (deferred to v1.2)
- `npx super-skills` entrypoint (local clone assumed for v1)
