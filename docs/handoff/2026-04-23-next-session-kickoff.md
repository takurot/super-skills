# Next-Session Kickoff — 2026-04-23

*Session 905f38bd continued into 2026-04-22 morning/afternoon; then
session 28d38f34 resumed mid-afternoon. Focus: user goal = "stability +
MLX 常時稼働". Yesterday (04-21) fixed the SIGKILL-137 storm via DB
shrink + jetsam-aware tuning. Today (04-22) pivoted to observability +
MLX memory hygiene verification + "zero error rate" pursuit.*

---

## Session-start ritual (3 min)

```
# 1. Health baseline
curl -sS http://127.0.0.1:3150/health | grep -q healthy && echo "vcontext OK"
curl -sS http://127.0.0.1:3161/health | grep -q healthy && echo "mlx-embed OK"

# 2. MLX kill freshness (is the jetsam loop active?)
sqlite3 ~/skills/data/vcontext-primary.sqlite \
  "SELECT COUNT(*) FROM entries WHERE type='anomaly-alert' AND content LIKE '%mlx-embed exit%' AND created_at >= datetime('now','-1 hour');"
# target: 0 when system is idle / 1-5 is the jetsam loop active

# 3. Backlog drain trend
curl -sS http://127.0.0.1:3150/ai/status | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'backlog={d[\"embedding_backlog\"]:,} embed_count={d[\"embedding_count\"]:,}')"

# 4. MLX latency snapshot (new /ai/latency endpoint)
curl -sS http://127.0.0.1:3150/ai/latency | python3 -m json.tool
```

If jetsam loop is active: that's the known-accepted pattern per user
decision (overnight-drain strategy). Not a regression.

---

## What shipped 2026-04-22 (7 commits)

```
5f6ed4a fix(watcher): graceful skip when no LLM available (A-alt)
95674e3 tune(mlx): keep-alive 30s→10s — pin 3.4GB model pages hot
39bbaee feat(mlx): keep-alive probe + latency instrumentation
0486713 fix(maintenance): SKILLS_DIR unbound at line 172
97ad526 feat(server): D2 — 3-tier probes /live, /ready, /startup
fc1094e feat(anomaly): RTOS-style cycle duration + jitter tracking (D1)
e75da6e fix(anomaly): RAM/SSD gap excludes SKIP_TYPES (false-positive fix)
e7813dc feat(server): detectAnomalies Check #8 — launchd service health
```

Plus plist updates (not commits):
- com.vcontext.mlx-embed.plist: added ProcessType=Interactive +
  LowPriorityIO=false (JetsamProperties tried but DOESN'T WORK for user
  LaunchAgents — lesson recorded).

---

## Major findings 2026-04-22

### 1. MLX latency breakdown (evidence from /ai/latency)
- **Single embed p50: 13ms** when keep-alive cache is warm (probe uses "ping", MLX server has text-level cache)
- **Batch embed p50: 3.8-22s** depending on swap pressure
- Cache hit explains the paradox of "slow drain but fast user-facing"
- Ring size 256, auto-rotates

### 2. jetsam priority 40 is IMMUTABLE for user LaunchAgents
- Researched + tested: `JetsamProperties` plist key is silently ignored
  for ~/Library/LaunchAgents/. Only /Library/LaunchDaemons (sudo) can
  override.
- Max effective protection for user-space:
  `ProcessType=Interactive` + `Nice=-20` + `LowPriorityIO=false` +
  `KeepAlive` auto-restart
- Already all set. No further knobs available.

### 3. MLX 3.4GB model gets swapped under daytime memory pressure
- Competing apps (Antigravity 810MB, Claude 665MB, Codex 499MB,
  Chrome multi ~1.4GB, vcontext-server 463MB) compete for ~36GB RAM
- MLX RSS oscillates 250MB-3.4GB — OS pages out 3GB of model weights
  between requests; keep-alive 10s only touches a fraction
- **User's overnight-drain strategy**: daytime = batch slow (swap), night
  = apps idle → RAM frees → drain accelerates. Accepted design.

### 4. Keep-alive pattern confirmed
- 10s interval, same "ping" text → MLX server cache hit → 6-14ms/probe
- Silent on success (spec) — Agent 1 initially flagged it as "INACTIVE"
  but /ai/latency n growth showed it WAS running
- Don't lower below 10s (would stress withMlxLock queue)

### 5. mlx-embed-server.py is already state-of-art for user-space
- `mx.metal.clear_cache()` called every batch (line 370)
- `gc.collect()` after every batch (line 371)
- `mx.metal.set_cache_limit(5GB)` at startup
- External research (Ollama / oMLX / MLX community) showed only SSD-
  tier cache as a non-implemented pattern — but Phase A was DEFERRED
  because backlog = unique text = 0% cache hit rate.

---

## Decisions captured 2026-04-22

- **A-alt (new-feature-watcher graceful skip)**: Don't pay for Anthropic
  API just to silence a nice-to-have daily alert. Script now exits 0
  on "ANTHROPIC_API_KEY not set" (commit 5f6ed4a).
- **Overnight-drain strategy for MLX backlog**: daytime accept slow
  batch (22s), nighttime drain naturally (other apps idle → RAM free).
  (vcontext decision id=234497 stored 2026-04-21 evening.)
- **Don't lower keep-alive below 10s**: would stress withMlxLock
  serialization.
- **Don't try to raise MLX jetsam priority**: user-space can't.
  Accept occasional jetsam kill + rely on launchctl auto-restart.

---

## Remaining work (prioritized)

### Unblocked / ready to pick up (参照系 first, 更新系 second, 5-step flow)
1. **backup exit=52 origin** — Check #8 anomaly surfaced a new LaunchAgent
   failure. Script at `scripts/vcontext-backup.sh`. Exit 52 is non-
   standard; could be curl timeout (28), pipefail, or custom code.
   Needs: grep the script, find exit paths, correlate with log.

2. **conversation-skill-miner exit=1** — Another Check #8 newcomer.
   LaunchAgent runs daily. Same pattern as new-feature-watcher — likely
   needs API key. A-alt approach (graceful skip) is a good template.

3. **(4) Model pre-load at startup** — mlx-embed-server.py currently
   lazy-loads on first request; a `mx.eval(dummy_input)` at startup
   would eliminate cold-start on every launchd restart. ~20 LOC.
   Consider after the 2 exit-code triages above.

### Deferred (evidence suggests low ROI)
4. **(3) Metal cache 5GB limit test** — Agent C suggested disabling
   to see if latency improves. Test is mlx-embed restart cycle (which
   itself loses warmth), so measurement is noisy. Defer until there's
   evidence the 5GB cap is actually the bottleneck.

5. **SSD cache tier (Phase A)** — DEFERRED. Backlog = unique texts →
   0% cache-hit impact on drain. Only helps rare repeat /recall. Not
   worth the complexity right now.

---

## Do NOT do these (2026-04-22 lessons)

- **Do NOT promote mlx-embed to /Library/LaunchDaemons without explicit
  discussion** — it works around jetsam but requires sudo install and
  MLX process runs as root. Security tradeoff not yet approved.
- **Do NOT drop keep-alive interval below 10s** — withMlxLock queue
  pressure would delay user-facing /store backfills.
- **Do NOT enable com.vcontext.mlx-generate without re-evaluating RAM
  budget** — it adds 6 GB resident, would worsen jetsam loop.
- **Do NOT run sqlite3 CLI UPDATE/DELETE on live DB** unless you know
  WAL-mode concurrency intimately. Yesterday's near-corruption came
  from mixing CLI + server writers. Prefer `POST /admin/*` endpoints
  or stop server first.

---

## Decisions stored in vcontext (SKAP)

- `id=aios-core-principle` (id=233105) — retain/learn/grow, local is
  a phase
- `id=mlx-overnight-drain-strategy` (id=234497) — day=accept slow,
  night=natural drain
- `id=keepalive-text-cache-amplifier` (id=234500) — same-text probe
  hits cache, 500× latency improvement

## Lessons stored in vcontext (SKAP, session=aios-shared-knowledge)

- `sqlite-recovery-invariant-violation` (id=232898)
- `pkill-9-cascade-during-sqlite-operation` (id=232899)
- `serial-root-cause-declarations` (id=232900)
- `zombie-fd-after-file-swap` (id=232901)
- `speculative-correlation-as-mechanism` (id=232902)
- `recovery-infrastructure-underestimation` (id=233106)
- `jetsam-user-launchagent-restriction` (id=TBD — stored 2026-04-22
  morning, see keepalive-text-cache entry sibling)

---

## Rollback paths

- **A-alt graceful skip**: revert commit 5f6ed4a
- **Keep-alive interval**: revert commit 95674e3 (30s default)
- **Keep-alive + latency instrumentation**: revert 39bbaee
- **3-tier probes**: revert 97ad526 (keep /health, drop /live /ready /startup)
- **Cycle duration tracking (D1)**: revert fc1094e

## Recovery points available

- vcontext-backup.sqlite (hourly, auto)
- vcontext-primary.sqlite (current, healthy, 3.55 GB)
- snapshots/daily-20260421-0754.db (yesterday, 8.8 GB pre-migration)
- vcontext-vec.db (all embeddings, independent binary)
- entries-wal.jsonl (append-only log, replay via /admin/replay-wal)

---

*Next session: start with backup exit=52 + conversation-skill-miner
exit=1 triage (both参照系 30 min total), then decide (4) model pre-load
vs session close.*
