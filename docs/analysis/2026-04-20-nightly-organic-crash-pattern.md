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

## 6. Implication for LLM recovery

The 2026-04-21 LLM recovery spec
(`docs/analysis/2026-04-21-llm-recovery-spec.md`) requires
**AC-R2: SIGKILL-137 count did not increase in the 4 hours
prior**. Tonight's evidence says that condition may not be
reachable simply by waiting — there is an unresolved crash class
that fires during normal maintenance cycles, not just during
deploys.

**Recommendation for tomorrow**:

1. **Before** attempting LLM recovery, confirm or rule out the
   above hypotheses. If H1/H2 is confirmed, patch the embed-loop
   retry semantics (bounded retry budget, exponential backoff
   with a hard cap) before enabling a second MLX service that
   would compound memory pressure.
2. If the first 2-4 hours of 2026-04-21 show no new SIGKILL-137,
   that's evidence the pattern is probabilistic (occasional, not
   deterministic), and the spec's soak condition becomes
   achievable.
3. If crashes continue at ≥1/h, LLM recovery is blocked until the
   underlying pattern is resolved. Do not attempt.

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
