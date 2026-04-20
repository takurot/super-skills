# C9 Decision Prep — buildRouteTable HTTP Cutover (H3)

*Created 2026-04-20 evening in preparation for the 2026-04-21 HITL
decision. Gathers evidence so the user can approve Option A or B
in a single turn with full context. Complements
`docs/specs/2026-04-21-stage-4.5-spec.md` §3.2.2 and handoff
`docs/handoff/2026-04-21-next-session-kickoff.md` P1.C9.*

---

## 1. What C9 changes

`buildRouteTable()` in `scripts/vcontext-hooks.js` (lines 520-568,
~50 LOC) is the one remaining caller that spawns `sqlite3` against
primary.sqlite from outside the server process.

Today's two spawns (lines 528 and 552) read:
- `SELECT content FROM entries WHERE type='skill-registry';`
- `SELECT content FROM entries WHERE type='skill-trigger' AND status='active';`

Both are short SELECTs. They happen inside a 60-second local cache
(`ROUTE_CACHE_TTL`), so actual invocation rate during active hook
use is roughly **once per minute per hook process**.

## 2. Evidence

### Current cost (pre-C9)

| Metric | Value |
|---|---|
| LOC in buildRouteTable | 50 |
| sqlite3 spawnSync calls per rebuild | 2 |
| Per-spawn fork+exec cost (macOS, M3) | 30-100 ms |
| Cache TTL | 60 s |
| Typical rebuild frequency | 1/min per hook process |
| Per-minute overhead (hooks) | ~60-200 ms |
| P1-loose-coupling violation | yes (external file-lock read on primary) |

### Why this matters

Per AIOS Constitution P1: every major concern is its own process
with its own lifecycle. `buildRouteTable` spawning sqlite3 against
primary.sqlite from the hook process **violates P1** even though
the spawn is read-only — it still holds a file lock on primary,
the exact pattern Stage 4.5 removed from every other caller.

It is also the last remaining spawnSync-against-primary in hook
code after C7/C7b.

## 3. Options

### Option A — read-only `Database` singleton in hooks.js

Open `new Database(DB_PATH, {readonly: true})` once in hooks.js,
reuse across `buildRouteTable` calls. Replaces the 2 spawnSync with
2 `db.prepare(...).all()` calls.

Pros:
- Zero new server-side endpoint surface
- Near-zero latency (no network hop, no fork)
- Reuses the existing cache scaffold in hooks.js
- Smallest diff (~30 LOC replace)

Cons:
- Still opens a second SQLite connection on primary.sqlite from
  outside the server process → **CLASS C caller** per the 2026-
  04-20 audit (`docs/analysis/2026-04-20-integrity-caller-audit.md`)
- Every new hook process forks its own SQLite handle, reintroducing
  a subtler form of the lock-contention risk (SQLite allows
  multiple readonly readers under WAL mode, but a migration /
  VACUUM on the server side still has to wait on all of them)
- Violates the **spirit** of P1: "contract-first, loopback OK,
  second-process reads NOT OK"
- A future audit will flag it

### Option B — new `GET /admin/route-table` endpoint + HTTP client

Server computes the route table in-process once (cached with a TTL
on the server side), exposes it at `GET /admin/route-table`. Hooks
side becomes a thin `fetch` with its own short-TTL cache.

Pros:
- Pure P1 compliant — no external file lock on primary
- Server can invalidate cache atomically on
  `POST /admin/skill-registry/*` mutations (already exists)
- Matches the contract-first pattern of the Stage 4.5 endpoints
- Scales cleanly if another process (Codex, Gemini) ever needs
  the same routing data — they get the same HTTP contract

Cons:
- Loopback network cost: ~1-2 ms per miss. Pays it roughly once
  a minute per hook process (cache amortizes)
- Adds a new endpoint + OpenAPI entry + test harness
- Rollback requires keeping a fallback code path for some soak
  time

### Cost comparison (back-of-envelope)

| Scenario | Option A | Option B |
|---|---|---|
| Cold miss | <1 ms (in-proc) | 1-3 ms (loopback) |
| Cached hit | <0.1 ms (map lookup) | <0.1 ms (map lookup) |
| Per-minute hook overhead | ≤1 ms | ≤5 ms |
| Primary file-lock contention risk | **yes** (CLASS C) | **no** |
| P1 compliance | **no** | **yes** |
| AC-2 compliance (no external sqlite on primary) | **no** | **yes** |

The ~4 ms/min difference is invisible to human perception.
P1-compliance is visible in every audit.

## 4. Recommendation

**Option B** — new `GET /admin/route-table` endpoint.

Rationale:
1. Compliance beats performance when the performance delta is
   <5 ms/min of hook-side work (invisible to UX)
2. Stage 4.5's entire thesis is that contract-first loose coupling
   is worth the loopback overhead; applying it to the biggest
   remaining caller completes the thesis
3. Option A leaves a latent class C caller that will trip future
   audits — cheap to avoid now, expensive to retrofit later

## 5. Implementation plan (if Option B approved)

| Step | File | LOC | Purpose |
|---|---|---|---|
| 1 | `scripts/vcontext-server.js` | +80 | new `GET /admin/route-table` handler + ENDPOINTS_LIST row + 60 s server-side cache invalidated on skill-registry writes |
| 2 | `docs/schemas/vcontext-api-v1.yaml` | +40 | OpenAPI stub (query params: `include_deprecated`, `max_age_min`; response shape) |
| 3 | `scripts/test-admin-route-table.sh` | +90 | TDD harness: RED→GREEN for auth, shape, cache behavior |
| 4 | `scripts/vcontext-hooks.js` | ~-50 / +40 | replace 2 spawnSync in `buildRouteTable()` with `getAdmin('/admin/route-table')`; keep existing local 60 s cache on hooks side for amortization |

Rollback: add an env gate `VCTX_ROUTE_TABLE_MODE=sqlite` (default
`http` post-cutover). If operations degrade during the 24 h soak,
flip the env var and hooks fall back to the current sqlite3
spawnSync path without a redeploy. Remove the fallback branch
after the soak passes clean.

Estimated total diff: ~210 LOC across 4 files, one commit. H2
once H3 is granted.

## 6. Open questions the user can pre-decide

- **Q1**: acceptable latency budget for hook entry? Proposed ≤10 ms
  p95 for the route-table fetch (it's one call per active prompt
  after cache warmup).
- **Q2**: should the fallback branch be removed after 24 h soak,
  or keep it as a permanent env-gated kill-switch? Proposed:
  remove after 72 h clean — hooks.js already has too many dead
  branches; we should keep the trunk tight.
- **Q3**: cache key — should the server's cache key on
  `include_deprecated` + `max_age_min`, or ignore query and serve
  a single cached payload? Proposed: single payload (hooks use
  default params anyway); spec's `include_deprecated=0&max_age_min=5`
  query becomes no-op hints.

## 7. If Option A is chosen instead

Implementation becomes a `Database` singleton + guarded close-at-
exit. Rollback is `delete` the singleton and revert. ~30 LOC diff
in `scripts/vcontext-hooks.js` only. Spec deviation documented in
commit message + a note added to
`docs/principles/AIOS-CONSTITUTION.md` §P1 about the class-C
exception.

---

*Source of truth for contract: `docs/specs/2026-04-21-stage-4.5-
spec.md` §3.2.2. Source of truth for decision: whichever of A / B
is recorded in the first 2026-04-21 handoff after the H3 response
lands.*
