# vcontext-server SIGKILL-137 Investigation (2026-04-23 09:XX JST)

READ-ONLY investigation. Scope: the 3 most-recent SIGKILL-137
restarts cited in the prompt (PIDs leading to 48437 → 87465 →
36511). Every factual claim cites file:line + quote.

## 1. Timeline (UTC from log; JST = UTC+9)

The log `/tmp/vcontext-server.log` has 6916 lines, 13 `exit code
137` events total, the last 3 being the "today" set. Wrapper
exit lines themselves have no timestamp (printed by bash),
so timing is bracketed by the timestamped lines that sandwich
each exit.

| Exit | Log line | Last timestamped line before exit | First timestamped line after restart | Gap | PID-after |
|---|---|---|---|---|---|
| 1 | `:5898` | `5897: 2026-04-22T15:57:48.639Z [vcontext:alert] 1 anomalies detected` | `5899: 2026-04-22T16:01:03.126Z [vcontext:index] Backfilled 50 entries` | ~3m 15s | 48437 (line 5970) |
| 2 | `:6358` | `6357: 2026-04-22T20:07:04.856Z [vcontext:sync] Caught up 1 entries RAM→SSD (241249→241250)` | `6359: 2026-04-22T20:07:27.518Z [vcontext:index] Backfilled 50 entries` | ~22s | 87465 (line 6430) |
| 3 | `:6831` | `6830: 2026-04-23T00:08:31.376Z [vcontext:sync] Caught up 2 entries RAM→SSD (241662→241664)` | `6832: 2026-04-23T00:13:34.517Z [vcontext:index] Backfilled 50 entries` | ~5m 3s | 36511 (line 6903) |

Inter-kill spacing: kill-1 → kill-2 = ~4h 10m, kill-2 → kill-3
= ~4h 1m. **Remarkably consistent ~4h cadence**, identical to
the `nightly-organic-crash-pattern` documented 2026-04-20
(`docs/analysis/2026-04-20-nightly-organic-crash-pattern.md`).

Pre-exit log tails are boring: all three showed normal
`embed-loop:rss` / `vcontext:sync` / `vcontext:alert 1 anomalies
detected` / `mlx-generate Probe failed ECONNREFUSED 3162`
cadence, no last-gasp error, no `[watchdog]` line.

## 2. Memory profile (RSS + heap trend; embed-loop:rss)

182 `[embed-loop:rss]` samples in log. Top-10 RSS values (MB):
619, 633, 638, 662, 704, 745, 761, 854, 881, **1497**. The 1497
outlier is at `:5500 2026-04-22T12:43:44.911Z iter=30 rss=1497MB
heap=706/859MB` — at iter=30 after a prior restart, not the
kills under study. Peak heap observed: `:6779 iter=450
rss=152MB heap=735/888MB`.

Trend leading to kill-3 (same-PID, iters 30→510, 23:59 UTC→
00:08 UTC):

```
6799  23:48:30 iter=480 rss= 881MB  heap=73/157MB
6817  23:59:05 iter=510 rss= 387MB  heap=12/17MB   ← GC dropped
6831  [wrapper] Server exited with code 137          ← kill
```

**No monotonic growth just before kill**; RSS visibly drops
15 min before exit. Node heap never crossed 1 GB of the 4 GB
--max-old-space-size (`scripts/vcontext-wrapper.sh:31`), so
Node self-crash on heap limit is ruled out. `vmmap 36511`
(current) reports `Physical footprint (peak): 1.7G` in 23 min
of uptime.

## 3. Root-cause hypothesis (ranked)

### H1 (STRONG): External SIGKILL from memory pressure (macOS userland) — NOT classic jetsam

Evidence against "jetsam kill":

- `launchctl print` shows `jetsam priority = 40`, but
  runningboardd log says verbatim:
  `2026-04-22 21:44:32.151953+0900 runningboardd: [osservice<com.vcontext.server(501)>:71370] is not RunningBoard jetsam managed.`
  `This process will not be managed.`
- `/usr/bin/log show --predicate 'eventMessage CONTAINS
  "memorystatus" OR ... "FG kill"' --last 18h` returned no
  hits for vcontext.

Evidence for memory pressure being the environment:

- `sysctl vm.swapusage` right now: `total=13312M used=12319M
  free=992M` (93% swap used).
- `vm_stat` shows `Pages occupied by compressor: 717407`
  (~11.2 GB compressed) and `Pages free: 22299` (~349 MB).
- Current competitors: Chrome Renderer RSS 1.15 GB,
  Antigravity LSP 902 MB, Claude renderer 799 MB, Codex
  renderer 465 MB, Claude desktop 446 MB. All at jetsam
  pri=100 (app tier), vcontext at pri=40 — **vcontext is the
  LOWEST priority among major consumers, so it dies first
  under pressure**.
- Prior analysis `docs/analysis/2026-04-20-nightly-organic-crash-pattern.md:121-142`
  established the crash chain: mlx-embed backlog → retry
  storm holds 4096-float buffers → RSS grows → kernel
  reclaims SQLite mmap pages → `"file is not a database"`
  errors (204 in current log) → eventually OS kills pri=40
  process.

"launchctl ... immediate reason = inefficient" is a **spawn
reason label**, not a kill reason (`log show` verbatim:
`launchd: [...com.vcontext.server [71370]:] Successfully
spawned bash[71370] because inefficient`).

[INFERRED] The specific kernel path in Sequoia/Tahoe that
sends SIGKILL to a `not RunningBoard jetsam managed` process
under swap exhaustion is not captured in the log queries I
ran; a `log show --predicate 'processIdentifier == <dead-PID>'`
at the exact kill second would confirm, but those PIDs are
gone.

### H2 (RULED OUT): Internal watchdog self-SIGKILL

`scripts/vcontext-server.js:304-334` has a worker-thread
watchdog that `process.kill(process.pid, 'SIGKILL')` if the
main event loop is unresponsive for 90 s. This path logs
`[watchdog] main event loop unresponsive for Nms — SIGKILL
pid=N` before firing (line 315).

`grep '\[watchdog\] main event loop'` returns **zero hits**
in `/tmp/vcontext-server.log`. H2 did not fire.

### H3 (RULED OUT): Wrapper zombie-kill

`scripts/vcontext-wrapper.sh:99-101` kills the child if it
doesn't bind port in 120 s. All three "today" exits were
followed by successful bindings within 20–58 s
(`[wrapper] server PID X bound port 3150 (after Ns)`), so
the child was healthy at kill time — the 137 came from
outside.

### H4 (RULED OUT): Node heap-limit overflow

Would produce `FATAL ERROR: Reached heap limit` + code 134,
not 137. Code 137 = 128 + SIGKILL(9). Max heap observed
888 MB << 4096 MB cap.

## 4. Fix plan validation — is cat=app pri=100 sufficient?

**Partially**. Moving vcontext-server from cat=daemon pri=40
to cat=app pri=100 (mirroring yesterday's MLX-embed cutover)
will:

- Remove the "first-victim" status — vcontext will tie with
  Chrome/Claude/Antigravity at pri=100 instead of being
  the obvious target.
- But pri=100 processes still die under severe pressure;
  macOS picks one. Current swap 93% used is not a transient
  — it's baseline. cat=app **delays** rather than
  **prevents**.

Concretely: if kill cadence today was ~4h at pri=40, after
pri=100 the cadence may stretch to ~8-12h [INFERRED — we
don't have a controlled experiment], which is an improvement
but not a fix.

## 5. Additional mitigations needed beyond cat=app

Ordered by leverage (per `2026-04-20-nightly-organic-crash-pattern.md:172-206`
"Revised recommendation", still-valid):

1. **Reduce the producer of pressure — mlx-embed retry
   storm.** The real driver per H1 is RSS growth from
   retry buffers + mmap reclaim under pressure. Options
   (all still unimplemented):
   - Exponential backoff on mlx-embed failures (retry
     currently aggressive).
   - Circuit-breaker: mlx-embed ECONNRESET ≥5×/60s →
     mark unavailable 5 min, store-path returns 202
     without embedding (backfill catches up).
   - Batch-size adapt: if backlog > 5000, drop batch
     16 → 4.

2. **Lower base RSS of the Node server**:
   - Currently 4 GB heap (`scripts/vcontext-wrapper.sh:31`)
     + 256 MB ramDb mmap (`scripts/vcontext-server.js:461`)
     + 128 MB ssdDb mmap (line 470). Heap cap is advisory;
     actual heap stays <1 GB. Reducing --max-old-space-size
     from 4096 to 2048 would set a harder upper bound (node
     would exit-134 instead of getting SIGKILL'd from
     outside — arguably a better signal for the wrapper).
   - `vcontext-primary.sqlite` is 4.14 GB on disk
     (`ls -la /Users/mitsuru_nakajima/skills/data/vcontext-primary.sqlite`).
     256 MB mmap is only ~6% of the file, so most queries
     take syscalls anyway. Dropping mmap to 64 MB might
     actually reduce mmap-reclaim pain at no query cost.

3. **Reduce system memory pressure from outside the Node
   process**:
   - Chrome is the single largest consumer (1.15 GB + 12
     other Chrome Helper renderers in the ps output).
     If the user can close unused Chrome tabs/windows,
     pressure drops materially.
   - Swap is 13.3 GB allocated / 12.3 GB used. The SSD
     resize mentioned in `2026-04-22-m2-m3-m5-m6-feasibility.md`
     would let swap grow without a ceiling, but that's a
     hardware project.

4. **Observability so next-kill evidence is better**:
   - Add a `[watchdog] rss=NMB swap_used=NMB` dump every
     15 s so the last-line-before-137 tells us the RSS at
     kill time, not 10 min prior.
   - Wrap `/usr/bin/log show --predicate 'eventMessage
     CONTAINS "com.vcontext.server"' --last 10m` into
     a post-restart capture script so the kernel-side
     evidence is preserved in the transcript.

## 6. Open questions not answerable from this log

- Exact kill-time RSS / swap state — not logged.
- Whether kill is synchronous with a specific store()
  / recall() request or happens mid-idle — not captured.
- Whether the DB-mmap-reclaim theory (H1 in the 2026-04-20
  doc) is the actual failure mode or a symptom — would
  require `sudo fs_usage -f filesys` during a soak test.

These gaps are exactly what mitigation #4 above would
close.

---

*Investigation by subagent, 2026-04-23. Source data:
`/tmp/vcontext-server.log` (6916 lines), `launchctl print`,
`/usr/bin/log show`, `vm_stat`, `vmmap 36511`, and prior
analyses under `docs/analysis/2026-04-20-*.md`.*
