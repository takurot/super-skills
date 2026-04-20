# AIOS Shared Knowledge — Source of Truth

*Status: living. Added 2026-04-20 in response to 2026-04-20 evening
observation that `~/.claude/CLAUDE.md` edits do not propagate to other
environments or other AI clients (Gemini, ChatGPT, Codex via a
different machine, etc.). Complements `AIOS-CONSTITUTION.md` (P1–P6).*

---

## Problem

Knowledge that needs to shape AI behavior across sessions is currently
written in multiple places with different reach:

| Store | Scope | Read by |
|---|---|---|
| `~/.claude/CLAUDE.md` | 1 machine, 1 user, Claude only | Claude Code sessions on that machine |
| `~/.claude/projects/.../MEMORY.md` | 1 project, Claude only | Claude Code (per-project) |
| `~/skills/**` files | 1 machine | This machine's sessions |
| **vcontext `/store` + `/recall`** | **machine, but HTTP-addressable** | **any client with port 3150 reach (or tunneled proxy)** |
| LaunchAgent plists | 1 machine | launchd |

Only vcontext is HTTP-addressable, meaning only vcontext can be read by
a different AI (or a different machine) via a network contract. All the
others are read-only via filesystem to the host machine.

## Principle — Source of Truth

> **vcontext is the authoritative store for AIOS-wide shared knowledge.
> Filesystem-based stores (CLAUDE.md, MEMORY.md, skill SKILL.md files)
> are local mirrors, cache adapters, or environment-specific overrides —
> not masters.**

When the same claim appears in both vcontext and a filesystem mirror,
vcontext wins. When a filesystem mirror is richer (because of a local
feature not yet speced), it MUST be lifted into vcontext before being
relied on across sessions.

## Corollaries

### C1 — Every shared lesson has a vcontext entry first
A failure pattern, architectural decision, naming convention, or any
generalizable claim MUST be written to vcontext before (or at the same
time as) being added to CLAUDE.md / MEMORY.md / skill docs. The
vcontext entry carries the canonical content; local mirrors carry only
pointers, hashes, or local-only reformulations.

Canonical types:

- `lesson-learned` — session-level failure patterns (retrospective)
- `decision` — architectural or operational decisions
- `design-proposal` — pending design work
- `skill-gap` — routing references to non-existent skills
- `anomaly-alert` — runtime anomaly observations

### C2 — Cross-AI access is a first-class design concern
A principle is useless if only Claude can read it. When posting a
shared lesson, assume it will be consulted by:

- Claude Code (current session's hook injection)
- Claude Code on another machine (via SSH tunnel / tailnet / public
  endpoint)
- Codex CLI, Gemini CLI, or any MCP-compatible client
- Self-evolve loop and other background processes
- Human operators reading the dashboard

Write content that reads as neutral AIOS-layer documentation, not as
Claude-specific prose. Avoid "I" / "私" in shared entries — use "the
AI" / "the agent" or imperative form.

### C3 — CLAUDE.md is a fast-path cache
The per-environment `~/.claude/CLAUDE.md` is a cache:

- populated at session start (directly or via SessionStart hook pull
  from vcontext)
- mutable as local override (user preference) without changing the
  shared truth
- NOT a store of record

If CLAUDE.md diverges from vcontext in content that applies universally,
vcontext wins. Sync direction is vcontext → CLAUDE.md, not the reverse.

### C4 — No shared claim without a retrievable tag
Every shared lesson MUST include:

- a stable `tags` array with at least one category tag (e.g.
  `evidence-before-claim`) and one specific identifier (e.g.
  `dismissive-negation`)
- a `session` field that is a knowledge namespace, not a session UUID,
  for shared entries. Reserved namespaces:
  - `aios-shared-knowledge` — cross-AI principles, lessons, patterns
  - `aios-design-proposals` — pending design work
  - `aios-health-monitoring` — anomaly / health signals
  - `aios-learning-bridge` — self-evolve intake / output

Personal session UUIDs stay on session-scoped entries (`assistant-
response`, `pre-tool`, etc.), not on shared knowledge.

### C5 — Hash over restate
When a skill doc or CLAUDE.md references a shared lesson, prefer a
1-line reference + entry id over duplicating prose:

    See vcontext lesson-learned id=224684 (dismissive-negation) for
    the rule: verify-before-negate.

Rewrites of the same content drift. Hash-linked references don't.

## Enforcement path

Until C1–C5 are enforced in code, they are a discipline. Proposed
enforcement layers (see
`docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md`):

1. **Pre-write hook**: when CLAUDE.md / MEMORY.md is edited to add a
   generalizable rule, hook checks vcontext has a matching entry first
2. **Bootstrap endpoint**: `GET /aios/bootstrap` returns the canonical
   shared-knowledge set, consumable by any AI client at session start
3. **Divergence report**: `/admin/kb-diff` compares local mirrors to
   vcontext truth and flags drift

## History

- 2026-04-20: principle drafted after user observation
  ("CLAUDE.md だと、その環境ごとに、追加しないといけない / 違う AI
  も利用できない"). Four failure patterns had just been written to
  CLAUDE.md before the principle was clear; they were then also posted
  to vcontext as `lesson-learned` entries 224681–224684 to satisfy C1
  retroactively. The gap exposed by the user — "CLAUDE.md は Claude
  専用" — motivated this doc.
