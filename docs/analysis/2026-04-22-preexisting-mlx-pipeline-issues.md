# Pre-existing MLX pipeline issues — root-cause analysis

Date: 2026-04-22 20:30 JST
Scope: READ-ONLY analysis. No code changes. Evidence + hypotheses + experiments only.
Running code: `scripts/vcontext-server.js` (PID 40617, 437 MB RSS), `mlx-embed-server-standalone.py` (PID 21385, port 3161)

## 1. Observed phenomena (with numbers)

### P1. Embedding backlog stalled

- **Live /ai/status** (2026-04-22 20:27): `embedding_backlog: 60,620`, `embedding_count: 132,678`, `embedding_eligible_total: 193,298`
- Audit baseline (briefing): 60,562 pre-cutover → 60,620 now → **+58 in ~3 h** (net grew, not drained)
- Stated drain rate: 0.014/s (50 rows/h) → 42 h ETA at this pace

### P2. 210 `[store] MLX embed failed` errors / 5215 log lines (~3 h window)

Distribution of error messages (`/tmp/vcontext-server.log`, full file):

| Message | Count |
|---|---:|
| `connect ECONNREFUSED 127.0.0.1:3161` | 174 |
| `read ECONNRESET` | 21 |
| `socket hang up` | 10 |
| `mlx embed timeout` | 6 |
| **Total store-path** | **211** |

Cross-check: briefing cited 174 ECONNREFUSED / 20 ECONNRESET / 10 hang-up / 6 timeout — matches within ±1.

Separate counters:
- `[embed-loop] batch failed`: **38** (background loop path) — 15 ECONNRESET, 12 embed_batch timeout, 7 hang-up, 4 ECONNREFUSED
- `[mlx-keepalive] fail`: **31** (probe path)
- `[mlx-generate] Probe failed ECONNREFUSED :3162`: **324** — separate issue (generate server 3162 down; unrelated to embed 3161)

### P3. Batch-size "collapse to 1"

The briefing cited `batch failed (1 rows …)`. Log inspection shows **17 of 38** batch-failed lines report 1 row; the majority still show 16. Timeline:

- Lines 1455–3644 (earlier period): all `(16 rows, …)` — steady BATCH=16
- Lines 3921–5218 (later): `(4)`, `(3)`, `(1)` appear. These match the `ORDER BY id DESC LIMIT 16` SELECT returning **< 16 unembedded rows because the eligible-recent window is drained**.

### P4. Latency — old (OLD prod, log-frozen) vs new (standalone)

/api/embeddings via `grep "POST /api/embeddings" | sort -n` percentiles:

| Path | n | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| OLD `/api/embeddings` (`mlx-embed-server.log`, 28 h) | 23 517 | 3.06 ms | 1.94 s | 30.1 s | 47.0 s |
| OLD `/embed_batch` | 4 493 | 5.03 ms | 32.3 s | 37.5 s | 44.7 s |
| NEW standalone `/api/embeddings` (1 h 34 min) | 2 440 | 3.14 ms | 1.65 s | 6.07 s | 22.7 s |
| NEW standalone `/embed_batch` | 152 | 1.44 ms | 13.4 s | 17.6 s | 21.1 s |

In-process `latency.single` counter from /ai/status: p50 1.16 s, p95 7.58 s, p99 16.2 s (n=256). The 5-8 s slow tail is confirmed.

## 2. Hypothesis tree

### P1 (backlog stall)

- **H1a (most plausible)** — the embed-loop SELECT filter excludes five noisy types but **still orders by `id DESC`** (`vcontext-server.js:3720`), so fresh inserts are processed first. If inserts ≥ embed rate, the 60 k backlog of OLDER eligible rows never gets touched. Writes today: working-state alone +791/day, skill-suggestion +20, handoff +192 (from /pipeline/health). Eligible writes ≥ embed throughput → no old-backlog drain.
- **H1b** — Circuit breaker opening (C11 D3, `:3786`) pauses the loop 120 s per outage. 4 observed opens × 120 s = 8 min idle / 3 h = 4 % loss. Insufficient to explain a 0.014/s drain.
- **H1c** — Store-path gate (C11 D4, `:1618`) skips embed on insert during open circuit. Rows that skip go straight into the backlog and compete with older rows under `id DESC` ordering. Coupled with H1a.
- **H1d (speculation)** — `dbQuery` path uses RAM sqlite. If RAM DB is missing rows that exist only on SSD (observed restore pattern `58 655 missing` at startup), the loop sees a smaller backlog than /ai/status's aggregate scan. Unverified.

### P2 (174 ECONNREFUSED on :3161)

- **H2a (most plausible)** — MLX embed server restarted one or more times during the 3 h window. ECONNREFUSED means process is not listening at all; ECONNRESET means mid-request drop. The live standalone uptime is 4 236 s (~70 min) but old log ended `2026-04-22 19:16:29` (shutdown) while new log began `2026-04-22 18:53:51` — **there is a 23-min overlap during cutover** where vcontext-server was calling a port in transition.
- **H2b** — macOS RunningBoard / jetsam killed the MLX process. Commit `3356d68 feat(mlx): standalone .app — jetsam cat=daemon→cat=app (pri 40→100)` suggests this was a recent mitigation — i.e., jetsam WAS killing it before today's cutover.
- **H2c** — Port bind race: standalone log line 11 `ERROR: [Errno 48] address already in use` followed by 44 s shutdown/re-start. During that window every /store embed fails ECONNREFUSED.

### P3 (batch shrinks to 1)

- **H3a (most plausible, benign)** — natural consequence of `ORDER BY id DESC LIMIT 16` after newest-row exhaustion; NOT a code bug. Log shows BATCH=16 in early window, mix of 16/4/3/1 later as the fresh-row queue drains per tick. The backlog-is-old-rows problem (H1a) means LIMIT 16 often matches fewer fresh eligible rows.
- **H3b (branch code lives on worktree only)** — commit `251b990 fix: embed batch→1` on branch `claude/serene-keller` modifies `BATCH = 3 → 1` at a lineno that doesn't exist in main (`:2585`). This worktree change is NOT in the running server. Briefing's "batch=1" is worktree state confusion.

### P4 (5-8 s slow tail)

- **H4a (most plausible)** — MLX model cold decode on larger inputs. Standalone p99 `/api/embeddings` 6 s vs OLD 30 s — large improvement, but tail remains. `keep-alive 30s→10s` (commit `95674e3`) intentionally pins pages hot, so tail is likely input-size-dependent (1000-char /store rows vs short keep-alive pings).
- **H4b** — Concurrency: /store setImmediate embed calls compete with embed-loop `_mlxEmbedBatchRaw` on the same server. Standalone server has no request queue concurrency knob in the log — serial request handling would add wait latency to the tail.
- **H4c (speculation)** — Python asyncio executor saturation under batch load. Single-thread `_mlx_executor` (per source: `scripts/mlx-embed-server-standalone.py:508`) means batches serialize. embed_batch p95 13 s supports this.

## 3. Correlations across issues

Causal map:

```
MLX :3161 restarts (H2a,b) ──► ECONNREFUSED (P2/174)
                          └──► /store setImmediate fails → row inserted WITHOUT embedding
                                                              │
                                                              ▼
                                              backlog grows by ~1/failed-store
                                                              │
    ORDER BY id DESC LIMIT 16 (H1a)                            │
       │                                                       │
       └──► embed-loop prefers NEW rows ◄───────────────────────┘
                │
                └──► old 60 k never drained (P1 stall)

Circuit breaker (C11 D3) opens during MLX outage
       └──► 120 s idle (P1 minor contributor)
       └──► store-gate skips embed ⇒ same row-without-embedding path
```

Independent: P4 slow-tail is an MLX-server-side property, unaffected by backlog; but slow tail raises the timeout failure rate (mlx embed_batch timeout=12 occurrences), contributing a small amount to P2.

## 4. Non-destructive experiments to validate

### E1 (validates H1a): swap backlog ordering during one tick

- Run: `curl -s 'http://127.0.0.1:3150/debug/embed-sample?order=asc&n=16'` (if endpoint exists) OR read-only probe:
  `sqlite3 /Volumes/VContext/vcontext.db "SELECT MIN(id), MAX(id), COUNT(*) FROM entries WHERE embedding IS NULL AND type NOT IN ('working-state','anomaly-alert','pre-tool','session-recall','test');"`
- Expected evidence: MIN(id) far older than recent entry IDs (>> 50 k id gap) → confirms loop prefers newer rows and skips old.
- Time: 1 min. Risk: none (SELECT only).

### E2 (validates H2a/c): correlate restart timestamps with ECONNREFUSED cluster positions

- Run: `grep -n "Starting Qwen3 Embedding Server\|Shutting down" /tmp/mlx-embed-server.log /tmp/mlx-embed-server-standalone.log`
  then `grep -nC 2 "ECONNREFUSED 127.0.0.1:3161" /tmp/vcontext-server.log | head -40`
- Expected evidence: every ECONNREFUSED cluster sits within 60 s window of a start/stop event.
- Time: 2 min. Risk: none.

### E3 (validates H4b): measure latency during embed-loop tick vs between ticks

- Run: for 5 minutes, `while true; do T=$(date +%s%3N); curl -s -X POST http://127.0.0.1:3161/api/embeddings -H 'content-type: application/json' -d '{"input":"ping"}' > /dev/null; T2=$(date +%s%3N); echo $((T2-T)); sleep 0.5; done | tee /tmp/e3.txt`
- Expected: bimodal histogram — fast (<1 s, between batches) + slow (>3 s, during batches). Unimodal = H4c dominates.
- Time: 5 min. Risk: adds ~300 req; within daily budget.

### E4 (validates H1b/c loop-idle-share): per-iteration status trace

- Run: `grep "embed-loop:rss\|circuit OPEN\|circuit CLOSED" /tmp/vcontext-server.log | tail -30`
- Expected evidence: circuit open windows sum to < 10% of wall-clock. If > 20 %, H1b becomes plausible.
- Time: 1 min. Risk: none.

## 5. Remediation plan sketch (deferred — do not apply until experiments agree)

### R1. Change embed-loop `ORDER BY id DESC` → mixed strategy (only if E1 shows MIN(id) gap)

- `vcontext-server.js:3720` — take 8 newest + 8 oldest per batch, OR alternate.
- Effort: ~5 LOC. Risk: low. May double recall latency slightly for freshest content.
- Evidence gate: E1 returns `MAX(id) - MIN(id) > 50 000`.

### R2. Protect store-path embed call with retry (only if E2 confirms restart-correlated failures)

- `vcontext-server.js:1624` — single retry after 500 ms delay. Preserves data on a transient restart.
- Effort: ~8 LOC. Risk: very low; already non-fatal.
- Evidence gate: E2 confirms ≥ 80 % of 174 ECONNREFUSED in restart windows.

### R3. Server-side request queue with bounded concurrency (only if E3 shows bimodal latency)

- `mlx-embed-server-standalone.py` — explicit asyncio.Semaphore(1) for the Metal executor (already de-facto serial; make it explicit and visible via 429-on-overflow).
- Effort: ~15 LOC. Risk: medium (affects prod throughput knob).
- Evidence gate: E3 shows p95-during-tick > 3× p95-between-tick.

## 6. Reconciliation numbers (per quality-gate)

Reconciled: **5 215 log lines read** (vcontext-server.log full-file) + **32 384 lines** (mlx-embed-server.log full) + **2 891 lines** (standalone full) = **40 490 log lines audited**. **2 endpoints queried live** (`/ai/status`, `/pipeline/health`). **10 code-point references** cited by `file:line`. **4 phenomena × 2–4 hypotheses = 13 hypothesis branches evaluated**. **4 experiments specified**, each read-only and ≤ 5 min runtime. **3 remediations sketched** with explicit evidence gates.

Code references used (file:line):
- `scripts/vcontext-server.js:1618` — store-path circuit gate (C11 D4)
- `scripts/vcontext-server.js:1624` — /store embed call (safeSliceCodePoints)
- `scripts/vcontext-server.js:3614-3812` — startEmbedLoop (full function)
- `scripts/vcontext-server.js:3715` — `const BATCH = 16`
- `scripts/vcontext-server.js:3720` — `ORDER BY id DESC LIMIT ${BATCH}` (H1a)
- `scripts/vcontext-server.js:3786` — circuit OPEN on streak≥3 (C11 D3)
- `scripts/vcontext-server.js:5777` — batch timeout 60 s (C11 D1)
- `scripts/vcontext-server.js:6059` — embeddingBacklog aggregate
- `scripts/mlx-embed-server-standalone.py:508` — `_mlx_executor` single thread
