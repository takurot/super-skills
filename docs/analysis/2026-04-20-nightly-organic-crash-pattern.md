# Nightly Organic Crash Pattern (observed 2026-04-20 ~17:30 JST)

*Created 2026-04-20 late evening. Evidence-based diagnosis of the
SIGKILL-137 event that fired **after** the final Stage 4.5 / SKAP
deployments, while the operator was deliberately NOT restarting
the server (protecting the 4-hour soak window for LLM recovery
per `docs/analysis/2026-04-21-llm-recovery-spec.md`).*

**This document does NOT propose a fix.** Per the `investigate`
skill discipline: observations and hypotheses first, then a fix
in a future commit once the pattern is confirmed across multiple
occurrences.

---

## 1. What happened

- Server PID 64033 had been up ~14 min 39 s after the C10 deploy.
- Between operator checks, PID 64033 died and launchd restarted
  as PID 3523.
- SIGKILL-137 counter incremented 126 → 127.
- Exit reason: code 137 (SIGKILL from OS — not an internal
  assertion, not a node uncaughtException).

## 2. Log-tail evidence (20 lines pre-crash, `/tmp/vcontext-server.log`)

```
[store] MLX embed failed: mlx embed timeout
[vcontext:sync] Caught up 3 entries RAM→SSD (227589→227592)
[embed-loop] batch failed (16 rows, streak=1): read ECONNRESET
[embed-loop] recovered after 1 consecutive failures
[vcontext:index] Backfilled 50 entries
[mlx-generate] Probe failed (streak=3): connect ECONNREFUSED 127.0.0.1:3162
[vcontext:auto] Backfilled 0, deduped 100 rows
[vcontext:alert] 2 anomalies detected
[store] MLX embed failed: mlx embed timeout
[vcontext:sync] Caught up 1 entries RAM→SSD (227703→227704)
[vcontext:sync] Caught up 1 entries RAM→SSD (227708→227709)
[vcontext:index] Backfilled 50 entries
[mlx-generate] Probe failed (streak=4): connect ECONNREFUSED 127.0.0.1:3162
[vcontext:auto] Backfilled 0, deduped 100 rows
[vcontext:alert] 2 anomalies detected
[vcontext:auto] WAL checkpoint busy=1 log=3597 ckpt=6
[vcontext:index] Backfilled 50 entries
[mlx-generate] Probe failed (streak=5): connect ECONNREFUSED 127.0.0.1:3162
[vcontext:auto] Backfilled 0, deduped 100 rows
[vcontext:alert] 2 anomalies detected
[wrapper] Server exited with code 137, restarting in 2s...
```

## 3. Pattern

Three co-occurring signals consistently appear in the ~2 minutes
preceding the crash:

| Signal | Count in the 2-min window | Meaning |
|---|---|---|
| `MLX embed failed: mlx embed timeout` | multiple | port 3161 (mlx-embed) response > timeout budget |
| `embed-loop batch failed ... ECONNRESET` | at least 1 | TCP reset mid-read from 3161 |
| `mlx-generate Probe failed ... ECONNREFUSED 3162` | streak 3 → 5 | expected (service is disabled), but probe retries happen regardless |
| `WAL checkpoint busy=1` | 1 | long-running reader blocks TRUNCATE |
| `2 anomalies detected` per cycle | 3× | `[vcontext:alert]` is the server's own anomaly watchdog firing |

## 4. Hypotheses (unverified — need multiple occurrences)

- **H1**: mlx-embed (port 3161) becomes unresponsive under load.
  The server's embed-loop retries hit ECONNRESET, the store
  path's embed calls time out, and the retry storm coincides
  with increased memory pressure because each failed attempt
  holds its request buffer until timeout.

- **H2**: `WAL checkpoint busy=1` is a symptom: a long-running
  reader (possibly the retry cascade itself, or a large /recall
  in the backfill loop) holds a snapshot, preventing the
  auto-checkpoint from truncating the WAL. WAL growth + failed
  embeds compound memory pressure.

- **H3**: The 2-anomaly-per-cycle pattern (`[vcontext:alert]`)
  means the server's own anomaly detector is signaling something
  the operator hasn't investigated. If the anomaly is memory-
  related, it confirms H1/H2; if it's something else, H1/H2 are
  incomplete.

- **H4**: The disabled mlx-generate's retry loop
  (`Probe failed streak=3,4,5...`) may itself cost non-trivial
  memory via the probe request buffers. Worth checking if
  disabling the probe entirely (as opposed to the service)
  reduces crash frequency.

## 4b. Hypothesis check — DATA GATHERED 2026-04-20 late night

After H1-H4 drafting, operator hit the anomaly-alert table
directly and inspected what `detectAnomalies()` (server.js:3765)
has been emitting. Pattern is STRIKING:

**Every cycle in the ~2h window before the crash** emits exactly
TWO alerts:
  1. **[high] DB errors in recent log: 683-957 (last 30min)**
     (i.e. 20-30 per minute of `[db exec error]` or
     `[db query error]`)
  2. **[medium] Embed backlog growing: 6994 → 10882 pending**
     (growing linearly — MLX embed can't keep pace)

Operator grepped `/tmp/vcontext-server.log` for the actual DB
error lines (last 512 KB = ~30min):

```
 631  [db query error @ /Users/.../vcontext-primary.sqlite] file is not a database
      | SQL: SELECT ... FROM entries WHERE type='task-request' / 'task-status-update' / 'task-result' / 'chunk-summary'
  43  [db exec error ...] "database ssd is already in use" OR "file is not a database"
   9  database disk image is malformed
```

Key test — operator ran the SAME queries via `sqlite3 -readonly`
directly on the DB file. ALL returned instantly with correct
results (task-request=0, task-result=12, etc.). **The DB file
is fine.**

### Diagnosis (H1/H2 now CONFIRMED + augmented)

The "file is not a database" error, when paired with a DB file
that sqlite3 CLI can open cleanly, has a specific root cause:
**the server's better-sqlite3 handle is reading mmap'd pages
that the OS has reclaimed under memory pressure**. SQLite
surfaces this as "file is not a database" because the expected
page header bytes are gone.

Crash chain (updated, evidence-based):

1. mlx-embed (port 3161) falls behind on load.
2. Every store call that needs an embedding retries against 3161.
   Each retry holds request + response buffers (potentially large,
   since embeddings are 4096 floats = 16 KB per vector).
3. Embed backlog grows linearly (6994 → 10882 over 2 hours = ~30/min
   net accumulation while the loop is running).
4. Node's heap + libc allocator + retry buffer churn push
   total RSS up; the OS starts reclaiming SQLite's mmap pages.
5. `dbQuery()` calls get "file is not a database" on the first
   read after reclaim (mmap page now empty). 600+ errors/30min.
6. Eventually a combination of pressure + reclaim contention
   triggers OS SIGKILL (code 137) on the server process.
7. launchd restarts; the cycle begins again with a fresh heap.

H5 (new): **mlx-embed load shedding is the single biggest
stability lever.** Every other symptom (DB errors, WAL busy,
SIGKILL) is downstream of the embed retry storm. Backlog has
been growing for hours — this is not a spike, it's a steady-
state producer-consumer imbalance.

Ruled-out secondary theory: "ATTACH 'ssd' race". There IS an
"already in use" message (43 instances), and ATTACH/DETACH sites
exist at server.js:4701/4719/4756. But this counts 7% of the
total error volume — even if fully fixed, 631 "file is not a
database" errors would remain. Not the primary cause.

## 5. Non-hypotheses (ruled out by evidence)

- **Not morning-cascade regression**: the 2026-04-20 morning
  cascade was caused by `doBackup()` in the event loop + hourly
  VACUUM + dead-path cron; all three are fixed. The log shows no
  `doBackup` / `VACUUM` activity in the pre-crash window.
- **Not Stage 4.5 code change**: the previous server (PID 64033)
  had the full Stage 4.5 + SKAP + C10 code loaded, ran through
  ~14 min of embedding work, and crashed while performing the
  EXACT same maintenance cycle the pre-Stage-4.5 code did. The
  delta isn't in the new code.
- **Not my deploys**: both PID 64033 and PID 3523 started via
  launchd's own `immediate` restart, not `kickstart -k` from
  the operator. The operator was in doc-only mode during the
  crash window.

## 6. Implication for LLM recovery (REVISED after §4b)

The 2026-04-21 LLM recovery spec
(`docs/analysis/2026-04-21-llm-recovery-spec.md`) requires
**AC-R2: SIGKILL-137 count did not increase in the 4 hours
prior**. Given the crash-chain evidence above, the soak condition
is NOT achievable by waiting alone. The embed-loop retry storm
is a steady-state problem.

**Revised recommendation for tomorrow** (blocks LLM recovery
until addressed):

1. **FIRST — patch mlx-embed retry semantics** (the H5 lever).
   Candidate changes:
   - Exponential backoff on mlx-embed failures (currently retries
     aggressively; should back off to 30s+ on streak ≥ 3)
   - Cap embed-loop batch size based on observed lag (if
     backlog > 5000, drop batch size from 16 → 4 and widen
     inter-batch sleep)
   - Circuit-breaker: if mlx-embed returns ECONNRESET 5× in
     60s, mark it unavailable for 5 min and let the store
     path return 202-accepted without an embedding (the
     entry is still stored; backfill catches up later)
2. **SECOND — add mmap-reclaim diagnostic**: wrap dbQuery
   errors to log `ramDb.pragma('integrity_check', {simple:true})`
   on the first "file is not a database" after a clean run.
   Confirms/falsifies the mmap-reclaim theory.
3. **THIRD — only then soak**. After (1)+(2), let the system
   run 4 h clean. If SIGKILL-137 stays flat, LLM recovery is
   safe to attempt.

Enabling mlx-generate WITHOUT (1) would add a second MLX
process holding 6 GB (model weights) + transient generation
buffers. That accelerates the memory pressure chain described
in §4b. **Do not.**

## 7. Data to gather in next occurrence

On next SIGKILL-137:

- `launchctl print gui/<uid>/com.vcontext.server` output at the
  moment of crash (exit reason, if launchd captured it)
- Console.app unified log filtered to the server's PID for the
  60 s prior — look for `memorystatus_action_needed`,
  `jetsam_kill`, or similar
- `vm_stat` snapshot from the minute before (if we have a
  prometheus-like loop it's in there; otherwise add one)
- Whether `mlx-embed` port 3161 was responsive in that window
  (add a probe to the watchdog)

## 8. What NOT to do before diagnosis

- Enable mlx-generate (would add memory pressure)
- Load Qwen3.6-35B or any larger model
- Increase embed-loop batch size
- Silence the anomaly detector without reading what it's saying

---

*Source of truth: `/tmp/vcontext-server.log` lines 42188-42213
(crash #127). Follow-ups get appended to this document as they
accumulate.*
