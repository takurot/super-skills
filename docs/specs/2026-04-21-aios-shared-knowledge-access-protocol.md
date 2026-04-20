# AIOS Shared Knowledge Access Protocol (SKAP) v1

*Status: draft. Created 2026-04-20 evening. Targets implementation
after Stage 4.5 completes and LLM recovery soak passes. Companion to
`docs/principles/shared-knowledge-source-of-truth.md`.*

## 1. Problem

Four lesson-learned entries (ids 224681–224684) and one design-proposal
(id 224670) were written to vcontext on 2026-04-20 so that failure
patterns observed during the session become shared knowledge. But:

- Claude Code sessions pick them up only via SessionStart hook which
  is Claude-specific
- Other AI clients (Gemini, Codex, a second Claude on a different
  machine, an MCP-compatible agent) have no documented way to pull
  these entries at session start
- `~/.claude/CLAUDE.md` was also updated, but that file is Claude-only
  and machine-local — so the lesson lives in two non-overlapping
  audiences

This spec defines a minimal protocol so any AI client can fetch the
shared-knowledge bootstrap set via HTTP contract (P2: contract-first).

## 2. Goals

- **G1**: Any HTTP client can retrieve the shared-knowledge set with a
  single authenticated request, returning JSON ready for system-prompt
  injection.
- **G2**: The set is partitionable by category (lessons-learned,
  decisions, design-proposals) so clients can opt in.
- **G3**: Response is stable enough to cache for 1 session, versioned
  so clients detect drift.
- **G4**: MCP-compatible tool definitions are published so MCP clients
  get structured access without custom glue.
- **G5**: Zero new dependencies on MLX, Docker, or any optional
  subsystem. Protocol must work with vcontext-server alone.

## 3. Non-goals

- Multi-user auth / ACLs (single-user AIOS for now)
- Write path for external AIs (read-only bootstrap first)
- Real-time push / subscribe (pull model only)
- Translation / summarization at serve time (raw entries)

## 4. Design

### 4.1 Bootstrap endpoint

```
GET /aios/bootstrap
  ?categories=lesson-learned,decision,design-proposal  (optional, default: all)
  &since=2026-01-01                                    (optional)
  &limit=200                                           (optional, hard max 500)
  &format=system-prompt|json                           (optional, default: json)

Headers:
  X-Vcontext-Admin: <token>   (same token used by /admin/* trio)

Response 200:
{
  "version": "skap-1",
  "generated_at": "2026-04-21T00:12:34Z",
  "content_hash": "sha256:...",
  "total_entries": 42,
  "by_category": {
    "lesson-learned": 4,
    "decision": 18,
    "design-proposal": 2
  },
  "entries": [
    {
      "id": 224681,
      "type": "lesson-learned",
      "session": "aios-shared-knowledge",
      "tags": ["lesson-learned","failure-pattern","evidence-before-claim","dramatic-diagnosis"],
      "created_at": "2026-04-20T22:07:42Z",
      "content": "<JSON string as stored>"
    },
    ...
  ]
}
```

- `format=system-prompt`: returns a pre-rendered markdown block suitable
  for direct injection into a system prompt, with each entry as a
  bulleted rule. Size-capped at 8 KB; truncates with a "see /recall for
  more" tail.
- Caching: `ETag` + `If-None-Match` supported. `content_hash` is
  deterministic over entry ids + content_hash of each entry.

### 4.2 Bootstrap contents

By default `/aios/bootstrap` returns:

- all `lesson-learned` entries in session `aios-shared-knowledge`
- all `decision` entries in session `aios-shared-knowledge`
- `design-proposal` entries with status="active" in session
  `aios-design-proposals`
- 0 `anomaly-alert` / `pre-tool` / `assistant-response` (session-scoped
  noise, not shared)

### 4.3 MCP tool definitions

Published at `GET /aios/mcp-manifest`:

```json
{
  "tools": [
    {
      "name": "aios_recall_lessons",
      "description": "Retrieve shared failure-pattern lessons from AIOS knowledge base. Call at session start or when making a claim you are not certain about.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "category": { "type": "string", "enum": ["evidence-before-claim","session-handoff","architecture","other"] },
          "limit": { "type": "integer", "default": 20 }
        }
      }
    },
    {
      "name": "aios_recall_decisions",
      "description": "Retrieve shared architectural / operational decisions.",
      "inputSchema": { ... }
    },
    {
      "name": "aios_store_lesson",
      "description": "Post a new lesson learned. Content must be JSON-serialized string; tags must include at least one category tag.",
      "inputSchema": { ... },
      "writeGate": "requires user confirmation — write path is HITL-guarded"
    }
  ]
}
```

Client-side, an MCP-compatible AI registers the manifest URL, Claude
Code / Codex / Gemini all resolve tool definitions the same way.

### 4.4 Auth model

- Bootstrap (read): header `X-Vcontext-Admin: <token>` — same token
  gate used by `/admin/integrity-check`, `/admin/backup`,
  `/admin/wal-checkpoint`, future `/admin/vacuum`. Token is a
  per-machine secret stored in `~/.aios/token` (chmod 600).
- MCP tools (read): same token
- MCP tools (write): same token + HITL gate (the `writeGate` field is a
  hint to the client to prompt the user)

For cross-machine access, token is passed through a tunnel (tailscale /
ssh -L) — AIOS does not publish to the open internet.

### 4.5 SessionStart hook integration

Existing `~/skills/scripts/vcontext-hooks.js` SessionStart hook already
injects session-recall content. SKAP adds a second injection block:

```
## AIOS Shared Knowledge (bootstrap v1)

Retrieved 2026-04-21T00:12:34Z, content_hash sha256:...

### Lessons learned (evidence-before-claim)
- [id=224681] Dramatic-narrative diagnosis: before stating "X causes
  Y", call at least one log/trace/PRAGMA that could falsify the claim.
- [id=224682] Self-congratulatory framing: before naming a pattern,
  verify the invariant holds.
- [id=224683] Stale price claim: time-sensitive facts via SearXNG.
- [id=224684] Dismissive negation: before saying "X doesn't exist",
  do a direct lookup.

### Active design proposals
- [id=224670] self-critique-2026-04-20-v2 — pre+post response layer.
```

Claude Code sessions get this automatically; other AI clients hit the
bootstrap endpoint directly.

## 5. Implementation phases

### Phase A — Bootstrap endpoint (~120 LOC server.js)
- Add `GET /aios/bootstrap` with categories + ETag
- Add `format=system-prompt` renderer
- Unit test: bootstrap returns current 4+1 known entries
- H2 (propose-then-execute)

### Phase B — SessionStart integration (~30 LOC hooks.js)
- Hook calls `/aios/bootstrap?format=system-prompt` at session start
- Injects result into session-recall output
- Fail-open if server unreachable
- H2

### Phase C — MCP manifest (~80 LOC server.js)
- Add `GET /aios/mcp-manifest` returning 3 tool definitions
- Add tool dispatcher mapping `aios_recall_lessons` → `/recall` with
  preset tags
- H2

### Phase D — Cross-machine tunnel docs (~1 runbook)
- Tailscale-based setup for second laptop
- ssh -L fallback
- No code changes
- H2

### Phase E — Write-path (deferred, post-Stage 4.5)
- `POST /aios/lessons` with HITL confirmation requirement
- Claude-in-the-loop validation of content format
- H3 — explicit user approval per post

### Phase F — Divergence detector (deferred)
- `/admin/kb-diff` compares CLAUDE.md sections to vcontext entries
- Flags drift in the dashboard
- H2

**Order**: A → B → (C ∥ D) → E → F. Phase A+B covers the minimum
viable path for this machine's Claude. Phase C opens the door to other
AI clients. Phase D enables cross-machine. E + F are later hardening.

## 6. Testing

- Contract test: POST a known `lesson-learned`, assert it appears in
  `/aios/bootstrap?categories=lesson-learned`
- ETag test: two requests with same state, second returns 304
- Size-cap test: insert 100 lessons, assert `format=system-prompt`
  truncates at 8 KB with correct tail
- Auth test: missing header → 401
- Cross-AI test (manual): curl from a Tailscale-connected laptop,
  verify same hash

## 7. Open questions

- **OQ1** — Should the bootstrap include `skill-gap` entries? They are
  health signals, not shared rules. Current answer: no (excluded by
  default, available via explicit query).
- **OQ2** — Should entries be versioned? A `lesson-learned` might be
  refined over time. Current answer: supersede via `supersedes_entry`
  field (already used by design-proposal v2). Bootstrap filters to
  non-superseded entries only.
- **OQ3** — How do other AIs authenticate without a Claude-specific
  hook? Options: env var, ~/.aios/token readable by all user-owned
  processes, per-AI token registry. Current lean: `~/.aios/token`
  chmod 600, any process running as the user has access.
- **OQ4** — Rate limit? Bootstrap is cached — low risk. But write path
  (Phase E) needs a rate limit. Proposed: 10 writes / hour, matches
  existing `/admin/` pattern.
- **OQ5** — How does this interact with the self-evolve loop? Self-
  evolve reads from vcontext directly (not through bootstrap) and
  writes pending-patches. No change. Bootstrap is an add-on consumer,
  not a replacement.
- **OQ6** — Should local CLAUDE.md edits still happen, or stop
  entirely? Answer: local edits remain for Claude-only optimizations
  and fast-path overrides, but generalizable rules MUST be in vcontext
  first (principle C1). Divergence detector (Phase F) catches drift.

## 8. Dependencies

- Stage 4.5 admin endpoint machinery (auth gate, rate-limit, OpenAPI
  sync) — SKAP reuses these patterns
- No dependency on MLX, Docker, SearXNG
- Works against SSD-only vcontext (RAM disk not required)

## 9. Non-dependencies / out of scope

- No new LaunchAgent
- No changes to Stage 4.5 Primary Sqlite access policy — SKAP is
  read-only HTTP and does not open new DB handles
- No change to `assistant-response` / `pre-tool` retention; those stay
  session-scoped

## 10. Success criteria

- A Gemini / Codex / second-Claude session on a Tailscale-connected
  laptop can `curl http://aios.tailnet:3150/aios/bootstrap` and receive
  the same 4 lessons + 1 proposal this Claude session posted.
- On opening a new Claude Code session, the lessons appear in the
  SessionStart injection block automatically.
- A CLAUDE.md edit that duplicates a vcontext entry is flagged by the
  divergence detector (Phase F).
- MCP-compatible clients register the manifest and call
  `aios_recall_lessons` without writing custom HTTP glue.

## 11. Related artifacts

- `docs/principles/shared-knowledge-source-of-truth.md` — why
- `docs/principles/AIOS-CONSTITUTION.md` — P1/P2/P3 foundation
- `docs/specs/2026-04-21-stage-4.5-spec.md` — admin endpoint pattern
  SKAP inherits
- vcontext entries: 224670, 224681, 224682, 224683, 224684 — what the
  protocol is designed to expose
