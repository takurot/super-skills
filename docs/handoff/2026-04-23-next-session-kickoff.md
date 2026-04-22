# Next-Session Kickoff — 2026-04-23

*Session 28d38f34 (2026-04-22 evening, ~4.5h). 16 commits shipped +
7 evidence files. Major outcomes: MLX embed runs as cat=app pri=100,
AIOS self-steering loop M1+M4 live, correction-event pipeline wired.*

---

## Session-start ritual (2 min)

```bash
# 1. Health baselines
curl -sS http://127.0.0.1:3150/health | python3 -c "import json,sys;d=json.load(sys.stdin);print('vcontext:',d['status'],'mlx:',d['mlx_available'])"
curl -sS http://127.0.0.1:3161/api/health | python3 -c "import json,sys;d=json.load(sys.stdin);print('mlx-embed backend:',d['backend'])"

# 2. Jetsam state (should still be app/100)
APP=$(launchctl list | awk '$3 ~ /^application\.com\.vcontext\.mlx-embed-standalone/ {print $3}' | head -1)
launchctl print gui/$(id -u)/"$APP" 2>&1 | grep -E "jetsam priority|jetsamproperties category"

# 3. M1-M4 loop pulse
curl -sS "http://127.0.0.1:3150/recent?type=skill-invocation-audit&n=3" | python3 -c "import json,sys; [print('  audit:',x.get('created_at','?'),'matched=',json.loads(x['content']).get('skills_matched_events'),'invoked=',json.loads(x['content']).get('skill_tool_invocations')) for x in json.load(sys.stdin).get('results',[])[:3]]"

# 4. Swap (was 14.86→12.96 GB trending down; expect continued drop)
sysctl -n vm.swapusage
```

---

## Tonight's 16 commits (2026-04-22 evening)

```
6ba7e52  docs(analysis): 3 independent-agent audits (mlx-generate + silent-catches + M2-M6)
b5d9a49  feat(hooks): LLM-enriched correction analysis (mlx-generate primary)
4d50259  feat(hooks): auto-detect user correction events + surface at bootstrap
e78d91c  fix(anomaly,hooks): post-review M1/M4 fixes (dedup + db-errors scope)
7c2f88b  feat(hooks): M4 bootstrap surfacing of anomaly skill-triggers
6101359  feat(hooks): M1 passive skill-invocation audit at session-end
606192d  feat(anomaly): route async launchd-unhealthy probe → respondToAnomalies
79871d3  fix(ai-status): split embedding_backlog into eligible / skipped / raw
42215e3  docs(handoff): AIOS self-steering meta-loop spec (M1-M6)
28fa60a  feat(anomaly): wire 6 unconnected alerts → skill-trigger reactive
85f8d55  docs(analysis): phase review + vcontext incompleteness audit
ea6ed8d  docs(analysis): 2026-04-22 pre-existing MLX pipeline issues
bd4cdeb  observability(vcontext): prepend ISO-8601 timestamps to console.*
3356d68  feat(mlx): standalone .app — jetsam cat=daemon→cat=app (pri 40→100)
```
(Plus `41f205c` / `9a7eee0` / `5f6ed4a` from earlier in the day.)

---

## Key outcomes

### 1. MLX embed runs as `cat=app pri=100`
- Cutover at 19:16 JST via `/usr/bin/open -W -n -a MLXEmbedServerStandalone.app`
- **Latency improved**: p50 -23%, p95 -72%, top-3 retrieval identical to mlx_lm baseline
- **Post-cutover monitor: 40/40 OK, 0 FAIL**
- Physical footprint 4.2 GB (vmmap). psutil-reported RSS is misleading (mmap swap).

### 2. AIOS self-steering loop active (M1 + M4)
- UserPromptSubmit → `skill-usage` entry (matched names)
- UserPromptSubmit → `correction-event` entry (regex-detected, 10 JP/EN patterns)
- respondToAnomalies → `skill-trigger` entry (anomaly-reactive, keywords)
- session-recall surfaces anomaly triggers + corrections at bootstrap
- session-end writes `skill-invocation-audit` (matched vs invoked ratio)
- **M1 verified: 6 real audit entries, rate=0.000 baseline captured**
- **M4 verified: empirical session-recall invoke shows "Recent Anomaly Skill-Triggers" section with db-errors entries**

### 3. Correction-event pipeline
- Regex fast path → `correction-event` (needs_enrichment=true) at hook time
- `cmdEnrichCorrections` uses mlx-generate :3162 primary, Claude API fallback, graceful-skip
- session-recall prefers TIER 1 (analysis) → falls back to TIER 2 (raw snippet)
- **Currently 0 correction-events stored** (detection fires going forward only)

### 4. Fixed pre-existing bugs
- `embedding_backlog` metric: now splits eligible / raw / skipped (was permanently 60k false-positive)
- `db-errors` alert detector: gates on process start time (no more re-scanning pre-restart corruption)
- anomaly-response: 4/13 → 11/13 alert types now have response branches

---

## Open questions (block M2-M6 progression)

User must decide these before M2 phase-2 (gate mode) can ship:

1. **M2 denominator**: AI-assertion gate triggers on ALL "done/complete/100%" claims, or production-critical-only?
2. **Bypass phrase**: unified `force:` for all mechanisms, or per-mechanism?
3. **PreToolUse block scope**: Edit / Write / Task only, or also Bash / Agent?
4. **M5 backfill**: retrospectively run M5 on today's session (session 905f38bd)?
5. **M6 `careful`-skill trigger**: keyword precision vs recall balance?
6. **evidence-gate log retention**: TTL for per-session audit data?

These are documented in `docs/analysis/2026-04-22-m2-m3-m5-m6-feasibility.md`.

---

## Next-session queued work (prioritized, from tonight's 3 audits)

### Tier 1 (immediate, small)
- [ ] **Fix 5 silent catches** per silent-catches-structuring.md top-5 list (~24 LOC). Biggest impact: `server.js:1636` which masks the ECONNREFUSED+backlog mechanism.
- [ ] **Verify M1 continues to fire** after this handoff + tomorrow's session. Expect new `skill-invocation-audit` entries with the NEW session IDs.
- [ ] **Verify M4 surfaces today's anomaly triggers** — next session-start should render the db-errors skill-trigger (if still within the FTS relevance window).

### Tier 2 (medium, decision-dependent)
- [ ] **mlx-generate re-enable decision**: staged-test path in mlx-generate-reenable-analysis.md, blocked on swap < 4GB + overnight timing. NOT yet safe per audit — swap 90% saturated.
- [ ] **Enrich accumulated correction-events**: mlx-generate first needs to be up; then `vcontext-hook-wrapper.sh enrich-corrections 10`.

### Tier 3 (spec-level, ~17h total)
- [ ] M2-shadow (2h) — log-only pre-claim evidence gate
- [ ] M5 (2h) — session-end retrospective entry
- [ ] M2-nudge (4h)
- [ ] M3 (4h) — second-opinion reminder injection (soften "auto-spawn")
- [ ] M2-gate (2h)
- [ ] M6 (3h) — production-freeze with 4 guards

---

## Rollback safety nets (untouched tonight)

- `mlx-embed-server.py` (original) — intact, not deleted
- `com.vcontext.mlx-embed.plist.bak-20260422-191626` — pre-cutover plist backup
- `/tmp/mlx-cutover.sh` (164 lines, auto-rollback on failure) — re-runnable
- Git: all 16 commits on `main`, no force-pushes, no reset

---

## Do NOT do these (tonight's lessons)

1. **Do not declare "0 errors" without filtering timestamps** — the log pre-cutover has 224 real errors from a prior corruption cascade. Time-filter (2026-04-22T13: onwards for post-fix era).
2. **Do not replace regex detector with LLM-only** — the user's explicit directive: regex is fast-path for unenriched events; LLM enriches when available. Two-tier design.
3. **Do not ask "shall I proceed?" between consecutive atomic tasks** — user called this out as "先延ばし"; execute the queue sequentially.
4. **Do not claim skill application without actually invoking the skill tool** — M1 now measures this; rate=0 baseline is the gap we're closing.

---

## Decisions stored in vcontext this session (SKAP)

Not formally stored (inline reasoning only). Consider on next session:
- `mlx-app-wrapper-for-jetsam` — bash-wrapper .app beats Nuitka for cat=app goal
- `ratio-zero-baseline` — 2026-04-22 905f38bd session measured 234 matches / 0 invocations
- `swap-90-blocks-mlx-generate` — don't re-enable until swap < 4GB + overnight

---

*End of handoff. Session closing at ~22:30 JST. Production green.*
