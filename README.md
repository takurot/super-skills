# Infinite Skills

> Status: 2026-04-27. AIOS Constitution active (`docs/principles/AIOS-CONSTITUTION.md`).
> See `CHANGELOG.md` for the 2026-04-18 → 27 stabilization sprint.

> (Repo / GitHub remote is still named `super-skills` for continuity with
> upstream, but the auto-routing skill and all internal references were
> renamed to `infinite-skills` on 2026-04-17.)

Unified skill framework for AI coding agents. Author once, deploy to **Claude Code**, **Codex**, **Cursor**, **Kiro**, and **Antigravity**.

## Quick Start

```bash
# Validate all skills
node scripts/validate-skills.js

# Build all targets
npm run build

# Smoke-test the running vcontext server (20 shape-asserting checks).
# Fails on regressions like missing fields, stale variable names, or
# dashboard JavaScript syntax errors.
npm test                 # full suite — includes a test write
npm run test:quick       # read-only subset

# Install into a project (Claude Code, developer profile)
node scripts/install-apply.mjs --profile developer --target claude --target-root /path/to/project

# Dry run to see what would be installed
node scripts/install-apply.mjs --profile core --target cursor --target-root . --dry-run
```

## Operations

### vcontext server (port 3150)

- **Start**: auto via `~/Library/LaunchAgents/com.vcontext.server.plist`
- **Reload**: `bash scripts/vcontext-reload.sh`
- **Health**: `curl localhost:3150/health`
- **Dashboard**: `http://localhost:3150/dashboard` (no-cache header — hard refresh not required after fixes)
- **Morning brief**: runs daily at 09:00 via `com.vcontext.morning-brief` → macOS notification + `data/morning-briefs/YYYY-MM-DD.txt`

### Watchdog tunables (env vars, all optional)

```
VCONTEXT_WATCHDOG_INTERVAL   60       # seconds between checks
VCONTEXT_WATCHDOG_COOLDOWN   300      # min notification gap
VCONTEXT_RAM_WARN_PCT        85       # RAM-disk fill warn
VCONTEXT_RAM_CRIT_PCT        95       # RAM-disk fill emergency cleanup
VCONTEXT_MLX_GEN_MAX_MB      14000    # MLX Generate kill threshold
VCONTEXT_MLX_EMBED_MAX_MB    10000    # MLX Embed kill threshold
VCONTEXT_MLX_GEN_CALL_LIMIT  200      # restart after N MLX calls
VCONTEXT_ALERT_WEBHOOK       ''       # Slack/Discord webhook URL
VCONTEXT_BRIEF_WEBHOOK       ''       # daily-brief webhook
```

### Data durability (defence in depth)

```
RAM DB  →  async SSD DB (same id)  →  async JSONL (data/entries-wal.jsonl)
       →  1-min RAM→SSD catch-up   →  5-min full backup
       →  daily + pre-deploy + pre-reboot snapshots (data/snapshots/)
       →  corrupt-RAM recovery: sqlite3 .recover + snapshot merge
```

Recovery endpoints (all idempotent):

- `POST /admin/replay-wal` — rebuild entries from JSONL if both SQLite DBs die
- `GET /admin/wal-status` — JSONL size + line count
- `POST /admin/verify-backup` — integrity-check last 10 snapshots
- `POST /admin/rollback-last` — revert most recent self-improve commit

See `RECOVERY.md` for the full cold-start procedure.

## Architecture

```
super-skills/
├── skills/                     # Master source (host-neutral)
│   ├── investigate/SKILL.md    # Root-cause debugging
│   ├── plan-product/SKILL.md   # Product planning
│   ├── review/SKILL.md         # Code review
│   ├── guard/SKILL.md          # Safety guard
│   └── ... (47 skills total)
├── scripts/                    # Build & install tools
│   ├── build-all.js            # Build all targets
│   ├── build-claude-skills.js  # → .claude/skills/
│   ├── build-codex-skills.js   # → .agents/skills/
│   ├── build-cursor-skills.js  # → .cursor/rules/skills/
│   ├── build-kiro-skills.js    # → .kiro/skills/
│   ├── build-antigravity-skills.js # → .antigravity/skills/
│   ├── install-apply.mjs       # Project installer
│   └── validate-skills.js      # Validation
├── manifests/                  # Profile/module/component definitions
│   ├── install-profiles.json   # core, developer, security, research
│   ├── install-modules.json    # Module groupings
│   └── install-components.json # Component → source mapping
└── package.json
```

## Profiles

| Profile | Skills | Use Case |
|---------|--------|----------|
| **core** | 10 | Minimal safe baseline |
| **developer** | 20 | Full engineering workflow |
| **security** | 11 | Audit and hardening |
| **research** | 13 | Deep research capabilities |

## Targets

| Target | Output Directory | Format |
|--------|-----------------|--------|
| Claude Code | `.claude/skills/` | SKILL.md (direct copy) |
| Codex | `.agents/skills/` | SKILL.md + openai.yaml |
| Cursor | `.cursor/rules/skills/` | .mdc files |
| Kiro | `.kiro/skills/` | SKILL.md + kiro.json |
| Antigravity | `.antigravity/skills/` | SKILL.md + catalog.json |

## Skills (47)

### Workflow Skills
- **investigate** — Root-cause-first debugging
- **plan-product** — Product planning before implementation
- **plan-architecture** — Architecture design before coding
- **review** — Code review focused on high-signal findings
- **security-review** — Security-focused code review
- **qa-browser** — Browser-based regression testing
- **ship-release** — Release preparation (no auto-push)
- **tdd-workflow** — Test-driven development

### Safety Skills
- **guard** — Block dangerous operations
- **freeze** — Read-only mode
- **careful** — Extra caution for critical operations
- **checkpoint** — Save/restore state
- **verification-loop** — Automated result verification
- **health-check** — Project health assessment
- **coding-standards** — Enforce coding standards
- **documentation-lookup** — Documentation search

### Knowledge Skills
- **api-design** — API design best practices
- **backend-patterns** — Backend architecture patterns
- **frontend-patterns** — Frontend architecture patterns
- **e2e-testing** — End-to-end testing patterns
- **deep-research** — Research methodology
- **exa-search** — Web search integration
- **mcp-server-patterns** — MCP server development
- **dmux-workflows** — Parallel workflow orchestration

## Safety Defaults

- No auto-commit — never pushes without human approval
- No telemetry — no data sent anywhere
- MCP/external tools require explicit opt-in
- `guard`, `freeze`, `careful` skills actively block dangerous operations

## Installer Options

```bash
node scripts/install-apply.mjs \
  --profile <core|developer|security|research> \
  --target <claude|codex|cursor|kiro|antigravity> \
  --target-root <path> \
  [--with component1,component2]   # Add extra components \
  [--without component1]           # Exclude components \
  [--dry-run]                      # Preview only \
  [--json]                         # JSON output
```

## Adding a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: "Use when..."
   origin: unified
   ---
   ```
2. Add sections: `## Rules`, `## Workflow`, `## Gotchas`
3. Register in `manifests/install-components.json`
4. Add to a module in `manifests/install-modules.json`
5. Run `npm run build` to verify

## License

MIT
