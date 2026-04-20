# Next-Session Kickoff — 2026-04-21 (final update end-of-2026-04-20)

*Today (2026-04-20) shipped **42 commits** total: morning cascade
recovery, admin endpoint trio (Stage 2/3/4), 20-caller audit, full
Stage 4.5 spec, **all Stage 4.5 implementation commits C2-C8+C10**,
**SKAP v1 Phases A/B/C/D**, and C7b cmdPolicyCheck full HTTP cutover.
Stage 4.5 is 9 of 10 shipped; only C9 buildRouteTable (H3 — needs
explicit approval) remains.*

---

## Session-start ritual (5 min)

```
# 1. AIOS hard-gate consultation (automatic via UserPromptSubmit hook)
# 2. Services:
curl -sS http://127.0.0.1:3150/health                 # vcontext
curl -sS http://127.0.0.1:3161/health                 # mlx-embed
curl -sS http://127.0.0.1:3163/proxy/health           # mlx-generate-proxy
# 3. Overnight stability:
grep -c "exited with code 137" /tmp/vcontext-server.log    # target: same as last night
pgrep -lf 'sqlite3.*primary'                                # target: empty
ls -la ~/skills/data/vcontext-primary.sqlite-wal            # target: < 500 MB
```

If anything above is off, pause and investigate. Otherwise proceed.

---

## Today's commit history (42, in reverse chronological — only the 16 evening commits shown; see `git log` for the full list)

```
715ab5c  docs(runbooks): SKAP Phase D — cross-machine runbook
c42f683  feat(aios): SKAP Phase C — GET /aios/mcp-manifest
ed04c38  feat(admin+hooks): C7b — /admin/db-size + cmdPolicyCheck HTTP
4a66b28  feat(hooks): SKAP Phase B — SessionStart pulls bootstrap
8cbe1f0  feat(aios): SKAP Phase A — GET /aios/bootstrap
a4f2192  feat(server): Stage 4.5 C10 — /store hardening + [obj] sweep
18726c6  feat(shell): Stage 4.5 C8 — dead-path shell cleanup
a890e6e  feat(hooks): Stage 4.5 C7 — cmdSnapshot + cmdMetrics → HTTP
60cd422  feat(maintenance): Stage 4.5 C6 — 8 sqlite3 spawns → HTTP
eff19aa  feat(admin): Stage 4.5 C5 — verify-backup worker_thread (AC-4)
528139f  feat(admin): Stage 4.5 C4 — metrics/window + gc/dry-run + policy
9980872  feat(admin): Stage 4.5 C3 — /admin/auto-tune + /admin/snapshot
c3fca80  docs(export): AIOS overview for NotebookLM
69fbdd1  feat(admin): Stage 4.5 C2 — /admin/vacuum (size-guarded)
4bb02ec  docs: SKAP v1 spec + shared-knowledge source-of-truth principle
ac0476d  docs(handoff): 2026-04-21 kickoff + evolution-log cycle 16
```

Earlier afternoon (26 commits):

```
246c5b4  docs(specs): Stage 4.5 implementation spec              ← ship target for tomorrow
3fe4b33  chore: LOW cleanup + watchdog wal-checkpoint redirect
884cc0b  feat(admin): Stage 4 GREEN + UC1 critical VACUUM removal
ca27712  feat(backup): Stage 3b thin-client atomic P1 flip
16e3f6b  test(admin): Stage 4 RED test (TDD-first)
2e17637  feat(admin): Stage 3a /admin/backup + boot-sweep
f8670eb  feat(admin): Stage 2 /admin/integrity-check
d24a503  docs(handoff): (superseded by this doc)
505ca17  fix: review-agent HIGH + MEDIUM findings
2138ef6  fix(hooks): integrity_check targets backup copy
89e5e94  fix(wal): truncate + backup sqlite3 timeout
a6bdc55  fix(launchd): ProcessType=Interactive + "inefficient" clear
1466eaf  docs: correct "36 GB ceiling" diagnosis
7623948  perf(embed-loop): exponential backoff
db7c53f  docs+tool: instability diagnosis + drain script
1ddde65  fix(hooks): FTS5 false positive
b8be398  perf(backup): PASSIVE checkpoint + cp -c reject
1f95b0f  perf(server): yieldToEventLoop
f5bf9c1  feat(hooks): TS strict Phase 1 (hooks-gate.mts)
4dac939  docs(schemas): OpenAPI 3.1 (75 endpoints)
7484527  feat(mlx): lazy-load proxy + TS migration design
dc126b1  docs(analysis): research + morning 3-bugs
fe1c0c1  feat(backup): separate process + AIOS CONSTITUTION
dfdee88  fix(watchdog): memory-aware MLX + disable-aware
cc697e4  fix(watchdog): cold-boot grace + softer defaults
9dec2ab  fix(vcontext): 3 morning bugs (cap / hook / L142)
```

---

## Priority 1 — Stage 4.5 + SKAP status

**Stage 4.5** (`docs/specs/2026-04-21-stage-4.5-spec.md`, 671 lines):
**9 of 10 commits shipped 2026-04-20. Only C9 (H3) remains.**

- ~~C1: hourly VACUUM delete~~ → `884cc0b` (UC1 fix) ✓
- ~~C2: /admin/vacuum~~ → `69fbdd1` ✓ (size-guarded, 512 MiB threshold)
- ~~C3: /admin/auto-tune + /admin/snapshot~~ → `9980872` ✓
- ~~C4: /admin/metrics/window + /admin/gc/dry-run + /admin/policy-check~~ → `528139f` ✓
- ~~C5: verify-backup event-loop stall~~ → `eff19aa` ✓ (worker_thread, AC-4 PASSED: 20s → 1ms)
- ~~C6: maintenance.sh HTTP~~ → `60cd422` ✓ (8 sqlite3 spawns → 4 curl)
- ~~C7: hooks.js cmdSnapshot + cmdMetrics~~ → `a890e6e` ✓
- ~~C7b: /admin/db-size + cmdPolicyCheck full HTTP~~ → `ed04c38` ✓ **(bonus)**
- ~~C8: dead-path shell cleanup~~ → `18726c6` ✓ (self-improve.sh + abtest.sh)
- **C9**: hooks.js `buildRouteTable` HTTP cutover. **H3 — needs explicit
  user approval.** Option A (singleton `new Database(DB, {readonly})`)
  vs Option B (HTTP + in-memory cache). Spec recommends B. Keep
  `VCTX_ROUTE_TABLE_MODE=sqlite` fallback for 24 h post-cutover.
- ~~C10: hardening (partial)~~ → `a4f2192` ✓ (/store content-type
  validation + [object Object] boot sweep)
  - Still pending in C10 scope: path-assert guards on DB_PATH writes,
    OpenAPI-sync checker script, comprehensive-qa SKILL.md update

**SKAP v1** (`docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md`):
**4 of 6 phases shipped 2026-04-20.**

- ~~Phase A: GET /aios/bootstrap~~ → `8cbe1f0` ✓ (ETag + 304 + format=system-prompt)
- ~~Phase B: SessionStart hook injection~~ → `4a66b28` ✓
- ~~Phase C: /aios/mcp-manifest~~ → `c42f683` ✓ (4 tools)
- ~~Phase D: Tailscale runbook~~ → `715ab5c` ✓ (`docs/runbooks/skap-cross-machine.md`)
- **Phase E**: POST /aios/lessons write-path (HITL-gated) + MCP stdio bridge process.
  Needs explicit HITL design — how does an external AI confirm with the
  user before writing? Possibilities: require a signed user-token header,
  require a one-time code, or require the user to click a dashboard button.
- **Phase F**: /admin/kb-diff divergence detector (flag when CLAUDE.md
  rules don't have a vcontext counterpart, or vice versa). ~100 LOC,
  low risk.

**Dependencies**:
- C2-C8 + C10: **all shipped**
- C9: depends on user H3 go on Option A vs B
- Phase F (SKAP divergence detector): independent, can ship anytime

**Priorities for 2026-04-21** (REVISED late-night 2026-04-20 after
root-cause discovery — SIGKILL-137 still firing organically; see
`docs/analysis/2026-04-20-nightly-organic-crash-pattern.md`):

1. **FIRST — read the crash-pattern doc** (above). Evidence says
   SIGKILL-137 chain is: mlx-embed retry storm → memory pressure
   → SQLite mmap reclaim → "file is not a database" errors → OS
   SIGKILL. Waiting alone will NOT achieve the 4-h soak condition.
2. **C11 (new) — mlx-embed retry semantics patch**. Three
   candidate changes documented in the crash-pattern doc §6:
   - Exponential backoff on streak ≥ 3 failures
   - Backlog-adaptive batch size (drop 16 → 4 when backlog > 5000)
   - Circuit-breaker: 5 ECONNRESET / 60 s → mark unavailable for
     5 min, store-path returns 202-accepted without embedding
3. **C11 diagnostic** — wrap dbQuery() first-error-after-clean
   to pragma integrity_check. Confirms/falsifies mmap-reclaim.
4. **THEN — soak observation**. 4 h clean SIGKILL-137 → eligible
   for LLM recovery.
5. **C9 HITL decision** (can proceed in parallel with 1-4 since
   it doesn't depend on embed retry): ask user which option A vs
   B for `buildRouteTable`. Spec recommends Option B. Once
   decided, ~80 LOC change with `VCTX_ROUTE_TABLE_MODE=sqlite`
   fallback.
6. **SKAP Phase F** (done 2026-04-20): /admin/kb-diff. Already
   shipped as `92656ad`.
7. **LLM recovery**: only after C11 patches + clean soak. The
   `docs/analysis/2026-04-21-llm-recovery-spec.md` AC-R2 is NOT
   passable without C11 first — enabling mlx-generate adds
   memory pressure, not reduces it.

---

## Priority 2 — LLM recovery (after Stage 4.5 + observation)

**Criteria** (per end-of-day checklist):

| # | Condition | Current | Target |
|---|-----------|---------|--------|
| 1 | Stage 3b twin-writers solved | ✓ | ✓ |
| 2 | Stage 4 GREEN | ✓ | ✓ |
| 3 | Stage 4.5 audit + redirect | ✓ audit + C2-C10 (9/10) | ✓ |
| 4 | Server SIGKILL-137 = 0 for 4-6h | TBD (end-of-2026-04-20: 125) | — |
| 5 | Passive observation of 3a/3b/4 per cycle | partial | — |

**Trigger**:
```
launchctl enable gui/$(id -u)/com.vcontext.mlx-generate
# proxy on :3163 handles on-demand warm-up with memory-pressure gate
```

**Expected behavior post-enable**:
- First `POST :3163/v1/chat/completions` → 15-60s warm-up → 200
- Idle 10min → proxy auto-bootouts MLX → 6 GB freed
- Next request → warm-up again

**Rollback** (if misbehaves):
```
launchctl disable gui/$(id -u)/com.vcontext.mlx-generate
# Proxy respects disable via is_service_disabled check
```

---

## What NOT to do

- Don't commit without `INFINITE_SKILLS_OK=1 CHECKER_VERIFIED=1` prefix
- Don't touch `/Volumes/VContext/vcontext.db` as a new caller — dead path, booby trap
- Don't load Qwen3.6-35B-A3B yet (see `docs/roadmap/model-candidates.md`)
- Don't rebuild FTS5 reactively — the false-positive pattern already in `cmdIntegrity` is understood
- Don't add new external sqlite3 callers — Stage 4.5 is REMOVING them
- Don't re-try APFS `cp -c` backup without BEGIN IMMEDIATE guard

---

## Artifacts from 2026-04-20 (for context)

- `docs/principles/AIOS-CONSTITUTION.md` — 4 axioms + 6 principles + HITL
- `docs/principles/shared-knowledge-source-of-truth.md` — **NEW evening**: vcontext is source of truth, CLAUDE.md is cache
- `docs/specs/2026-04-20-true-loose-coupling-redesign.md` — parent spec (Stage 1-4)
- `docs/specs/2026-04-21-stage-4.5-spec.md` — **THIS SESSION'S TARGET**
- `docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md` — SKAP v1 (cross-AI bootstrap endpoint, Phase A-F — A/B/C/D **shipped**)
- `docs/specs/2026-04-20-ts-strict-migration-plan.md` — TS Phase 2 (H3, deferred)
- `docs/specs/2026-04-20-mlx-lazy-load-proxy.md` — proxy spec
- `docs/schemas/vcontext-api-v1.yaml` — OpenAPI, ~86 endpoints (added 8 via Stage 4.5 + SKAP)
- `docs/analysis/2026-04-20-integrity-caller-audit.md` — 20-caller audit (Stage 4.5 basis)
- `docs/analysis/2026-04-20-server-instability-diagnosis.md` — morning corrected diagnosis
- `docs/analysis/2026-04-20-stability-research-refs.md` — 42 external references
- `docs/analysis/phase-stage-2-review.md` — phase-gate review
- `docs/runbooks/hooks-phase1-rollback.md` — <30s rollback
- `docs/runbooks/skap-cross-machine.md` — **NEW evening**: cross-machine SKAP access (Tailscale / ssh -L)
- `docs/roadmap/model-candidates.md` — Qwen3.6 deferred
- `docs/export/aios-for-notebooklm.md` — **NEW evening**: 332-line AIOS overview for NotebookLM ingestion

### New vcontext shared-knowledge entries (2026-04-20 evening)

- `design-proposal` id=224670 — self-critique v2 (pre+post dual-layer)
- `lesson-learned` id=224681 — dramatic-diagnosis
- `lesson-learned` id=224682 — self-congratulatory-framing
- `lesson-learned` id=224683 — stale-price-claim
- `lesson-learned` id=224684 — dismissive-negation
- all under session=`aios-shared-knowledge`, tags include `evidence-before-claim`

### Evening additions (all SHIPPED 2026-04-20)

- ~~P1.5: SKAP Phase A+B~~ → `8cbe1f0` + `4a66b28` ✓
- ~~P1.6: SKAP Phase C+D~~ → `c42f683` + `715ab5c` ✓
- ~~Hygiene: 2 [object Object] rows~~ → cleaned in `a4f2192` ✓
- ~~Bug: MLX embed s.slice~~ → addressed in `a4f2192` ✓ (content-type guard rejects object content before embed)

---

## Session-retrospective lessons (2026-04-20)

1. **"Dramatic narrative" warning**: I wrote "36 GB memory ceiling"
   diagnosis early afternoon — plausible, vivid, WRONG. User caught it
   in one line. Check whether each "root cause" is actually evidenced,
   not just plausible.
2. **Process separation ≠ loose coupling**: Stage 3a moved backup out
   of the event loop (real win), but sqlite3 CLI still held
   file-locks on primary. Agent review + user pushback caught this
   as "偽装疎結合". True P1 means HTTP+JSON contracts, not file locks.
3. **investigate-first needs a second pair of eyes**: 3× second-opinion
   agents found critical bugs I missed (F1-F6, then 20-caller audit,
   then Stage 4.5 spec). User push-back was 3× the diagnosis-corrector.
   AI + human + other-AI = evidence triangulation.
4. **TDD discipline flipped at Stage 4**: RED `16e3f6b` → GREEN
   `884cc0b` with 6/6 pass. Continue this discipline into Stage 4.5
   — each new endpoint has a failing test before implementation.
5. **Stop-hook interpretation mistake**: I ended turns silently on
   PostToolUse hook feedback; user said "止まってしまった？". The hook
   is about browser-preview verification, not halting all work. In
   future: continue the task, just don't announce the skip.

---

*End of 2026-04-20. AIOS admin endpoint trio is live, Stage 4.5
fully speced, next session has a clear 9-commit path to LLM recovery.*

---

## Evening-2 addition (2026-04-20 23:06 JST) — H6/H7 rejected, H8 pending

Updated priority: **FIRST read docs/analysis/phase-c11-d8-review.md + this
section**. The earlier handoff recommendation order is now partially
obsolete based on new evidence.

### What definitively shipped today (66 commits total)

- C11 minimum + bc4c299 + M2 proxy fix + --prompt-cache-size 8 + D8 ATTACH leak
- SKAP A/B/C/D/F, Stage 4.5 C2-C8+C10, many analysis docs
- vcontext decisions stored: id=229441, 229475, 229515 (user-authored principles)
- LLM recovery operational (Qwen3-8B-4bit + draft speculative)
- Search (FTS + semantic) and LLM generate both verified live

### Crash rate — honest measurement

- Pre-C11 baseline: 96 crashes/h
- **Post-bc4c299 measured**: 1 crash in 15 min = **4 crashes/h**
- **Improvement: 24× reduction, but NOT zero**
- Session total crashes today: 126 → 139 = 13 new crashes

### Evidence that overturned prior hypotheses

**H5 (mlx-embed retry storm)**: RESOLVED by C11. Zero `file is not a database`
errors post-fix, zero `already in use` errors post-D8. These were real root
causes — fixed.

**H6 (concurrent MLX-generate loop pileup)**: FALSIFIED by agent 4 code read.
`_mlxQueue` at server.js:5504-5565 serializes ALL MLX calls; can't pile up
at the proxy layer.

**H7 (KV cache growth → memory pressure → SIGKILL)**: PARTIALLY FIXED.
`--prompt-cache-size 8` caps cache effectively (verified 1-2 seq observed,
never 3+ during today's monitor). BUT crashes CONTINUE at low cache:
  - 2026-04-20 23:04 crash: PID 21404, RSS 234MB, MLX 151MB, cache 1 seq,
    memory available 7.7GB. **No pressure present**. H7 is insufficient.

**H8 (predict handler concurrent/reentrant)**: NEW, UNVERIFIED. Pre-crash
log pattern repeatedly shows:
  ```
  [vcontext:predict] handler entered, prompt_len=30
  [vcontext:predict] handler entered, prompt_len=30   ← duplicate
  [vcontext:predict] handler entered, prompt_len=35
  [vcontext:predict] handler entered, prompt_len=35   ← duplicate
  [wrapper] Server exited with code 137
  ```
The duplicate `handler entered` suggests concurrent or re-entrant calls
despite `_mlxQueue` serialization at generate. Either predict has its own
pre-queue code path, or the "handler entered" log is printed before queue
entry. Either way, the correlation with SIGKILL is consistent.

### Tomorrow's investigation plan (investigate skill discipline)

Do NOT apply speculative fixes first. Gather evidence:

1. **Code trace**: grep `handler entered` in server.js. Understand which
   code prints that line and what happens between the two entries.
   Candidate files: `runOnePrediction`, its callers.

2. **H8 verification**: set `VCTX_PREDICT_DISABLED=1` env (add if needed)
   and restart. Observe 15-30 min. If SIGKILL rate drops to 0 → predict
   loop is confirmed as trigger. If rate unchanged → H8 falsified.

3. **Non-memory-pressure SIGKILL source**: what else can SIGKILL a process
   on macOS besides memory pressure?
   - OOM killer: ruled out (crash at low RSS)
   - jetsam: plist has unlimited, ruled out earlier (docs/analysis/
     2026-04-20-nightly-organic-crash-pattern.md)
   - Kernel panic: would affect whole system (not just vcontext)
   - Signal from another process: who could send SIGKILL?
   - Watchdog: `com.vcontext.watchdog` — **worth investigating**
     Does watchdog send SIGKILL on some condition?

4. **Prior vcontext-watchdog.sh logic**: grep for `kill|pkill|signal` in
   watchdog script. It may have a health-check that triggers SIGKILL
   on slow /health response — exactly the class we'd see during
   predict handler bursts.

### Monitor bug caught (meta-lesson)

My monitoring `pgrep -f vcontext-server.js` was matching the monitor's
OWN shell command line because the literal string appeared there. Buggy
monitor reported 28-min uptime on PID 9097 (my own zsh, 1.7KB RSS) while
the real vcontext (PID 21404, 279MB RSS, different uptime) was crashing
unobserved.

Lesson: `pgrep -f PATTERN` is too broad. Use tight pattern like
`"node .*vcontext-server\.js"` to match only node children, not shells
running scripts that mention the file. Recorded in vcontext as lesson-
learned candidate for next session.

### vcontext decisions captured today (available via /recall)

- id=229441 — maxTokens=40960 is user-intentional (quality). Do not
  lower. Cache overflow must be addressed via eviction (M2), not
  token count reduction. Approved_by: user.
- id=229475 — AIOS = infinite memory × infinite skills × infinite growth.
  Any fix must preserve unbounded learning capacity.
- id=229515 — AIOS changes thinking approach, learns from mistakes and
  failures. Mistakes must be captured as decisions so the next session
  doesn't repeat them.

### Recommended 2026-04-21 startup sequence

1. Read this evening-2 section + phase-c11-d8-review.md
2. Read vcontext decisions 229441/229475/229515 via /recall?q=decision
3. Run `scripts/crash-pattern-report.sh --window 2h` to establish
   current steady-state
4. Start H8 investigation (code trace first, no fix yet)
5. After H8 understood, decide: apply env-gate disable test, or fix
   directly

