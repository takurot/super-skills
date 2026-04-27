# Super Skills Implementation Plan

## Planning Basis

This plan is derived from `docs/SPEC.md` and must stay aligned with that file. If implementation decisions diverge, update `docs/SPEC.md` first, then update this plan.

## Delivery Strategy

Implement in phases with a stable core first:

1. Repository foundation
2. Skill system foundation
3. Core workflow skills
4. Codex runtime and multi-agent support
5. MCP catalog and profiles
6. Plugin adapters
7. Security hardening and validation
8. Expansion packs

## Phase 1: Repository Foundation

### Task 1.1: Create canonical directory layout

Create:

- `skills/`
- `.agents/skills/`
- `.codex/`
- `.codex/agents/`
- `mcp/`
- `mcp/profiles/`
- `plugins/`
- `plugins/claude/`
- `plugins/opencode/`
- `plugins/cursor/`
- `manifests/`
- `scripts/`

Deliverable:

- Repository skeleton exists and matches `docs/SPEC.md`

Validation:

- Directory tree is present
- No generated content is mixed into source directories

### Task 1.2: Add root documentation stubs

Create:

- `README.md`
- `docs/ARCHITECTURE.md`
- `plugins/README.md`
- `mcp/README.md`

Deliverable:

- The repository explains the separation between source skills, generated skills, MCP, plugins, and manifests

Validation:

- Docs reference `docs/SPEC.md`

## Phase 2: Skill System Foundation

### Task 2.1: Define source skill schema

Decide and document the minimum expected structure for `skills/<name>/`:

- `SKILL.md` required
- `assets/`, `references/`, `scripts/` optional

Deliverable:

- Source skill contract documented

Validation:

- A validator can reject invalid skill directories

### Task 2.2: Build skill generation pipeline

Implement `scripts/build-skills.ts` or equivalent to:

- read `skills/`
- generate `.agents/skills/<name>/SKILL.md`
- generate `.agents/skills/<name>/agents/openai.yaml`
- enforce description length and metadata quality

Deliverable:

- Single command generates Codex-facing artifacts from source skills

Dependencies:

- Task 1.1

Validation:

- Running the generator creates expected `.agents/skills/` output
- Running it twice is idempotent

### Task 2.3: Build validation scripts

Implement scripts to validate:

- source skill presence
- generated skill presence
- metadata correctness
- duplicate skill names

Deliverable:

- A `validate-skills` command

Dependencies:

- Task 2.2

Validation:

- Validator passes on clean state
- Validator fails on missing `SKILL.md`

## Phase 3: Core Workflow Skills

### Task 3.1: Create `plan-product`

Merge ideas from:

- gstack `office-hours`
- gstack `plan-ceo-review`
- gstack `plan-design-review`

Scope:

- product framing
- wedge definition
- UX and design scoring
- challenge assumptions

Deliverable:

- `skills/plan-product/SKILL.md`

Validation:

- Skill clearly routes product and design planning work

### Task 3.2: Create `plan-architecture`

Merge ideas from:

- gstack `plan-eng-review`
- ECC `api-design`
- ECC `backend-patterns`

Scope:

- architecture review
- data flow
- API shape
- testability
- edge cases

Deliverable:

- `skills/plan-architecture/SKILL.md`

Validation:

- Skill covers architecture, API, performance, and testing expectations

### Task 3.3: Create `investigate`

Use gstack `investigate` as the base.

Scope:

- root-cause-first debugging
- investigation before edits
- evidence, hypotheses, and implementation separation

Deliverable:

- `skills/investigate/SKILL.md`

Validation:

- Skill forbids speculative fixing

### Task 3.4: Create `review`

Merge:

- gstack `review`
- ECC `coding-standards`
- ECC framework-specific review references later as optional extensions

Scope:

- correctness
- regression risk
- trust boundaries
- missing tests

Deliverable:

- `skills/review/SKILL.md`

Validation:

- Findings-first review format is explicit

### Task 3.5: Create `security-review`

Merge:

- gstack `cso`
- ECC `security-review`
- ECC `mcp-server-patterns`

Scope:

- app security
- secrets
- dependency and supply-chain review
- MCP and agent security
- threat-model prompts

Deliverable:

- `skills/security-review/SKILL.md`

Validation:

- Includes severity-based reporting
- Covers MCP-specific risk classes

### Task 3.6: Create `qa-browser`

Merge:

- gstack `browse`
- gstack `qa`
- ECC `e2e-testing`

Scope:

- browser testing
- regression capture
- report-only vs fix mode

Deliverable:

- `skills/qa-browser/SKILL.md`

Validation:

- Distinguishes test-only and fix-capable flows

### Task 3.7: Create `ship-release`

Merge:

- gstack `ship`
- gstack `document-release`
- ECC `verification-loop`

Scope:

- verify
- review
- changelog/docs sync
- branch and PR prep

Deliverable:

- `skills/ship-release/SKILL.md`

Validation:

- No implicit auto-commit or auto-push in default path

### Task 3.8: Create `health-check`

Use gstack `health` as the base and fold in ECC verification framing.

Deliverable:

- `skills/health-check/SKILL.md`

Validation:

- Build, lint, tests, types, and security are included

### Task 3.9: Create safety skills

Create:

- `skills/careful/`
- `skills/freeze/`
- `skills/guard/`
- `skills/checkpoint/`

Deliverable:

- Safety and session-control skills exist as first-class workflows

Validation:

- Boundaries and destructive-action warnings are documented

## Phase 4: Codex Runtime and Multi-Agent Support

### Task 4.1: Create `.codex/AGENTS.md`

Scope:

- explain local skill discovery
- explain core skills
- explain multi-agent roles
- explain security assumptions without hooks

Deliverable:

- `.codex/AGENTS.md`

Validation:

- Matches actual repository structure

### Task 4.2: Create lean `.codex/config.toml`

Scope:

- Codex-safe defaults
- lean MCP baseline
- multi-agent enabled
- no unsafe broad default config

Deliverable:

- `.codex/config.toml`

Dependencies:

- Phase 5 design decisions

Validation:

- File is syntactically valid TOML
- Only approved baseline MCPs are enabled by default

### Task 4.3: Create role configs

Create:

- `.codex/agents/explorer.toml`
- `.codex/agents/reviewer.toml`
- `.codex/agents/docs-researcher.toml`

Deliverable:

- Reusable multi-agent roles

Validation:

- Each role has a clear read-only or review-only responsibility

## Phase 5: MCP Catalog and Profiles

### Task 5.1: Create `mcp/catalog.json`

Catalog candidate MCP servers from ECC and classify them by:

- risk
- secret dependency
- default enablement
- profile membership

Deliverable:

- `mcp/catalog.json`

Validation:

- Every entry includes required fields from the spec

### Task 5.2: Create profile files

Create:

- `mcp/profiles/core.json`
- `mcp/profiles/research.json`
- `mcp/profiles/browser.json`
- `mcp/profiles/security.json`
- `mcp/profiles/unsafe-local.json`

Deliverable:

- Explicit MCP profile groupings

Validation:

- `core` contains only approved baseline services
- high-risk or localhost services are excluded from `core`

### Task 5.3: Add config generation or translation helper

Implement helper script to emit `.codex/config.toml` fragments or installation guidance from MCP profiles.

Deliverable:

- `scripts/build-mcp-config.ts` or equivalent

Validation:

- Generated output matches selected profile set

## Phase 6: Plugin Adapters

### Task 6.1: Add plugin architecture docs

Document plugin philosophy:

- thin adapters only
- opt-in execution
- no hidden core behavior

Deliverable:

- `plugins/README.md`

### Task 6.2: Add minimal host adapters

Create minimal placeholders for:

- Claude plugin support
- OpenCode plugin support
- Cursor support

Deliverable:

- Adapter directories and design docs

Validation:

- They do not auto-enable unsafe automation

### Task 6.3: Port only safe hook ideas

Candidates:

- formatting reminder
- typecheck reminder
- MCP health checks
- compact/state persistence ideas

Do not port by default:

- auto-approval
- telemetry
- broad auto-execution

Deliverable:

- A documented allowlist of approved hook behaviors

## Phase 7: Security Hardening and Validation

### Task 7.1: Secret scanning

Add repository checks for:

- hardcoded secrets
- committed placeholder secrets in active config
- plaintext secret recommendations in source docs

Deliverable:

- `scripts/scan-secrets.*`

Validation:

- Scan fails on known bad patterns

### Task 7.2: Dependency audit

Add commands for:

- `npm audit`
- `bun audit`

Deliverable:

- Dependency audit documented in validation flow

Validation:

- Audit command output is captured in docs or CI

### Task 7.3: Config linting

Validate:

- manifest JSON
- MCP catalog JSON
- generated metadata
- TOML config presence

Deliverable:

- `validate-configs` command

### Task 7.4: Security review pass

Run a dedicated pass over:

- skill defaults
- MCP defaults
- plugin defaults
- secret handling

Deliverable:

- `docs/SECURITY-REVIEW.md`

## Phase 8: Installer System

### Task 8.1: Define installer manifest schema

Design and implement the schema for:

- `manifests/install-components.json`
- `manifests/install-profiles.json`
- `manifests/install-modules.json`

The schema must support:

- profiles
- user-facing components
- low-level modules
- target filtering
- risk labeling
- generated vs authored file semantics

Deliverable:

- Manifest schema and initial manifest files

Validation:

- Manifest validation script rejects inconsistent references

### Task 8.2: Implement install planning CLI

Implement `scripts/install-plan.*` to:

- resolve profile and component selection
- filter by target
- emit human-readable output
- emit JSON output
- support dry-run planning

Deliverable:

- Install planner command

Dependencies:

- Task 8.1

Validation:

- Planner reports selected modules, skipped modules, target paths, and risk notes

### Task 8.3: Implement install apply CLI

Implement `scripts/install-apply.*` to:

- apply a resolved install plan
- copy authored assets
- generate generated assets
- track install state
- avoid clobbering authored user changes silently

Deliverable:

- Install apply command

Dependencies:

- Task 8.2

Validation:

- Re-running install is idempotent
- Generated assets can be rebuilt safely

### Task 8.4: Implement install validation and listing commands

Implement:

- `scripts/install-validate.*`
- `scripts/list-installables.*`

Scope:

- validate requested target/profile/component selections
- list supported profiles, components, and targets

Deliverable:

- Install validation and discovery commands

Validation:

- Invalid targets and unknown components fail fast with clear errors

### Task 8.5: Implement target adapters

Add install-target logic for:

- `codex`
- `claude`
- `opencode`
- `cursor`

The first stable path may fully support `codex` and provide scaffold-level support for the others.

Deliverable:

- Target-aware install mapping

Validation:

- `codex` install path is fully functional
- Other targets have explicit supported/partial status

### Task 8.6: Add installer state tracking

Implement state recording so later runs can:

- detect previous installs
- compute drift
- support repair and upgrade planning later

Deliverable:

- Installer state file format and writer

Validation:

- State contains no secrets
- State enables repeatable planning

## Phase 9: Expansion Packs

### Task 9.1: Add knowledge-pack skills

Bring in modular ECC-derived skills next:

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

Deliverable:

- Secondary skill layer beyond the core workflow set

### Task 9.2: Add profile-backed expansion modules

Map expansion skills into install modules so they can be included selectively by profile and target.

Deliverable:

- Expansion skills are integrated into the installer model

## Cross-Cutting Constraints

### Constraint 1: No default unsafe side effects

Do not ship default behaviors that:

- send telemetry
- auto-approve permissions
- auto-commit
- auto-push
- auto-upgrade
- inject routing files

### Constraint 2: Source and generated content must stay separate

- `skills/` is authored
- `.agents/skills/` is generated

### Constraint 3: Lean by default

The initial implementation should prefer:

- fewer skills
- clearer ownership
- smaller enabled MCP set
- explicit profiles for everything else

## Execution Order

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 4
4. Phase 5
5. Phase 3
6. Phase 7
7. Phase 8
8. Phase 9
9. Phase 6

Rationale:

- Build the repository contract first
- Make generation and runtime stable before adding many skills
- Lock security and MCP defaults before installer automation and capability expansion

## Phase 10: Skill Build Pipeline Enhancements (v1.1)

These tasks address gaps identified after the v1 core was implemented. They do not restructure the pipeline;
they fill specific holes in the existing scripts.

### Task 10.1: Add Claude frontmatter injection to `build-claude-skills.js`

Scope:

- Add `injectClaudeFrontmatter(content)` to `scripts/lib/skill-metadata.js`
  - Input: raw SKILL.md content string
  - Output: content string with `user-invocable: true` inserted after the last source frontmatter key
  - Must not modify source files; only operates on in-memory content
- Update `scripts/build-claude-skills.js` to call `injectClaudeFrontmatter` before writing each skill
- Write unit tests for `injectClaudeFrontmatter` covering:
  - Standard injection case (user-invocable not present)
  - Content with multiline description block
  - Throws when content already contains a host-specific key (should not reach injection stage due to validate guard)

Dependencies:

- None; operates on existing `scripts/lib/skill-metadata.js` module

Deliverable:

- `.claude/skills/<name>/SKILL.md` files contain `user-invocable: true` in frontmatter after build

Validation:

- `npm run build:claude-skills && grep -r "user-invocable: true" .claude/skills/` returns one match per skill
- `npm run validate:skills` continues to pass (source skills unchanged)
- Unit tests pass

### Task 10.2: Implement drift detection script

Scope:

- Create `scripts/check-drift.js` as a standalone Node.js script (CJS, consistent with other `scripts/*.js`)
- For each directory in `skills/`, check three generated artifacts per skill:
  - `.agents/skills/<name>/SKILL.md` — verbatim copy; compare SHA-256 of source directly against this file
  - `.agents/skills/<name>/agents/openai.yaml` — derived from source metadata; regenerate expected YAML
    in memory using the same `buildOpenAIYaml` logic as `build-skills.js` and compare against this file
  - `.claude/skills/<name>/SKILL.md` — frontmatter-injected; render expected content in memory using
    `injectClaudeFrontmatter` (from Task 10.1) and compare against this file. Do NOT compare source hash
    directly because the injected `user-invocable: true` makes the content intentionally differ.
- Report each drifted or missing artifact by skill name and artifact path
- Output format (default):
  ```
  DRIFT  investigate   .claude/skills/investigate/SKILL.md (stale)
  DRIFT  review        .agents/skills/review/SKILL.md (missing)
  OK     careful
  ```
- Output format (`--json`):
  ```json
  {
    "drifted": [
      { "skill": "investigate", "artifact": ".claude/skills/investigate/SKILL.md", "reason": "stale" }
    ],
    "ok": ["careful", ...]
  }
  ```
- Exit code 0 when no drift; exit code 1 when any drift detected
- Update `package.json`:
  - Add `"check:drift": "node scripts/check-drift.js"`
  - Prepend `npm run check:drift &&` to the existing `check` script

Dependencies:

- Task 10.1 must be complete: `injectClaudeFrontmatter` must be importable from `scripts/lib/skill-metadata.js`
  before the Claude-target drift check can render expected content for comparison

Deliverable:

- `npm run check:drift` passes on a clean build
- `npm run check:drift` fails with exit 1 after manually modifying a source skill without rebuilding
- `npm run check` runs drift check before building

Validation:

- Modify `skills/review/SKILL.md` → `check:drift` exits 1 and reports `review` as drifted
- Manually corrupt `.agents/skills/careful/agents/openai.yaml` → `check:drift` reports `careful` as drifted
- Manually edit `.claude/skills/investigate/SKILL.md` to remove `user-invocable: true` → `check:drift` reports `investigate` as drifted
- Run `npm run build:skills && npm run build:claude-skills` → `check:drift` exits 0

### Task 10.3: Add `--force` flag to `install-apply.mjs`

Scope:

- In `scripts/install-lib.mjs > parseArgs`, add `--force` flag → `options.force = false` default, `true` when passed
- In `scripts/install-apply.mjs > copyFileSafely`, change authored-file guard:
  ```
  Before: throw when content differs and !generated
  After:  throw when content differs and !generated and !options.force
  ```
- Forward `options.force` from `applyPlan` call site into `copyFileSafely` and `copyDirectorySafely`
- In dry-run text output, add line `Force mode: authored file overwrites enabled` when `options.force` is true
- Update usage string in `install-apply.mjs` to document `--force`

Dependencies:

- None; isolated change to existing apply logic

Deliverable:

- `--force` flag accepted without error
- Re-running install after local edits to an authored target file succeeds with `--force`, fails without it

Validation:

- Install to a temp dir → manually edit `.claude/AGENTS.md` → re-run install without `--force` → exits 1
- Re-run install with `--force` → exits 0, file is overwritten
- Dry-run with `--force` prints `Force mode` notice

### Task 10.4: Implement `install-status.mjs`

Scope:

- Create `scripts/install-status.mjs` (ESM, consistent with other `scripts/*.mjs` installer scripts)
- Parse `--target <codex|claude>`, `--target-root <path>`, `--json` flags using the existing `parseArgs` from `install-lib.mjs`
- Locate state file: `<targetRoot>/.super-skills/install-state/<target>.json`
- If state file does not exist: report `NOT INSTALLED` and exit 1
- Expand `state.pendingOperations` into concrete expected paths:
  - For `copy` operations: the `to` path is a concrete file or directory to check
  - For `generate` operations whose `outputRoot` maps to a known directory: check that the output directory
    is non-empty (individual generated files are not enumerated in v1.1)
  - For `write-state` operations: skip (meta-operations, not user-visible files)
  - Do NOT rely on `state.targetPaths` alone, as those are top-level directories that may exist even
    when their contents are missing or incomplete
- For each expanded path, verify existence under `targetRoot` and (for directories) non-emptiness
- Collect `OK` and `MISSING` results
- Default output:
  ```
  Installed: claude  profile=developer  at=2026-04-09T10:00:00Z
  OK      .claude/skills (non-empty directory)
  MISSING .claude/AGENTS.md
  ```
- JSON output:
  ```json
  { "installed": true, "target": "claude", "profile": "developer", "ok": [...], "missing": [...] }
  ```
- Exit 0 when all expanded paths present; exit 1 when any missing or not installed

Dependencies:

- No dependency on Task 10.3. The state file format written by `install-lib.mjs > writeStateFile` and
  `buildStatePayload` already exists in the current implementation and is stable. Task 10.4 can be
  implemented and tested independently of the `--force` change in Task 10.3.

Deliverable:

- `scripts/install-status.mjs` command functional for `codex` and `claude` targets

Validation:

- Install to temp dir → `install-status.mjs --target claude --target-root <dir>` exits 0
- Delete `.claude/AGENTS.md` → `install-status.mjs` exits 1 and reports `MISSING`
- No state file → exits 1 and reports `NOT INSTALLED`

### Task 10.5: Add convenience `package.json` entry points

Scope:

- Add the following scripts to `package.json`:

  ```json
  "install:claude":        "node scripts/install-apply.mjs --profile developer --target claude --target-root ~",
  "install:codex":         "node scripts/install-apply.mjs --profile developer --target codex  --target-root ~",
  "install:plan:claude":   "node scripts/install-plan.mjs  --profile developer --target claude --target-root ~ --dry-run",
  "install:plan:codex":    "node scripts/install-plan.mjs  --profile developer --target codex  --target-root ~ --dry-run",
  "install:status:claude": "node scripts/install-status.mjs --target claude --target-root ~",
  "install:status:codex":  "node scripts/install-status.mjs --target codex  --target-root ~"
  ```

- `~` resolves to `process.env.HOME` in Node via shell expansion; verify this works on macOS and Linux before committing

Dependencies:

- Task 10.4 (`install-status.mjs` must exist before its entry point is added)

Deliverable:

- `npm run install:plan:claude` produces a readable plan without flags
- `npm run install:claude` installs to `~` with no additional arguments

Validation:

- `npm run install:plan:claude` exits 0 and prints profile/target summary
- `npm run install:status:claude` exits 0 after a successful `npm run install:claude`
- `npm run install:status:codex` exits 0 after a successful `npm run install:codex`

## Execution Order (v1.1)

Run Phase 10 tasks in dependency order:

1. Task 10.1 (Claude frontmatter injection) — no dependencies
2. Task 10.2 (drift detection) — after 10.1; requires `injectClaudeFrontmatter` to be importable
3. Task 10.3 (--force flag) — no dependencies; can run in parallel with 10.1 and 10.2
4. Task 10.4 (install-status) — no dependency on 10.3; can run in parallel with 10.1–10.3
5. Task 10.5 (package.json entry points) — after 10.4 (`install-status.mjs` must exist)

## Definition of Done

The first meaningful milestone is complete when:

- `docs/SPEC.md` and `docs/PLAN.md` exist
- repository skeleton exists
- skill generator exists
- 6 to 12 core unified skills exist
- `.codex/` baseline exists
- MCP catalog and profiles exist
- install manifests and planner exist
- secret scanning and config validation exist

The broader v1 is complete when:

- installer apply and validation flows exist
- modular expansion skills are added
- plugin adapters are present and opt-in
- security defaults are verified and documented

v1.1 is complete when:

- `.claude/skills/` contains `user-invocable: true` in all generated skill frontmatter
- `npm run check:drift` detects stale generated artifacts
- `npm run install:claude` and `npm run install:codex` work without additional flags
- `npm run install:status` reports install health
- `--force` flag allows safe re-installation over modified authored files
