# P0d Observability Audit: 15s-Interval RSS/Swap Dump (READ-ONLY)

**Date**: 2026-04-23  
**Scope**: Feasibility of adding watchdog memory snapshots to vcontext-server startup sequence  
**Context**: SIGKILL-137 kills today lack RSS/swap evidence immediately pre-death (see `2026-04-23-vcontext-sigkill-137-investigation.md`)

---

## D1: Where does it plug in?

**Finding**: Best insertion point is `server.listen()` callback, line 10492.

- **Existing loops**: `_loopHeartbeat` object (line 3609) already tracks embed, discovery, chunk_summary, chunk_summary_l2, chunk_summary_l3 loops. All run via `setInterval`.
- **Embed-loop pattern** (line 3676–3682): Uses `_loopHeartbeat.embed = Date.now()` + counter, then every N iterations logs `[embed-loop:rss]` with `process.memoryUsage()`.
- **Watchdog**: Already exists at startup (line 304–334), implements 90s event-loop sentinel with worker thread. Does NOT keep process alive (uses `.unref()` at line 325).
- **Insertion point**: After line 10507 (`globalThis._startupCompleteAt = new Date().toISOString();`), add a `startMemoryWatchdog()` function call that spawns `setInterval(logMemSnapshot, 15000).unref()`.

**Why `.unref()`**: The watchdog loop must not extend process lifetime. Node will exit cleanly when main event loop has no other pending timers. Per line 325, this pattern is already established in the codebase.

**File**: `/Users/mitsuru_nakajima/skills/scripts/vcontext-server.js:10492` [CONFIRMED by read]

---

## D2: What data to collect at each tick?

**Recommended format** (balances density vs log noise):

```
[watchdog] rss=234MB heap=89/156MB external=4MB sys_free=980MB swap_used=12.3GB/14GB
```

**Data sources**:

1. **`process.memoryUsage()`** (line 3681, already imported via Node.js built-in):
   - `rss`: Resident set size (physical pages the process holds)
   - `heapUsed / heapTotal`: JavaScript heap utilization
   - `external`: C++ objects outside JS heap (e.g., sqlite3 statement caches)

2. **System-wide memory**:
   - `os.freemem() / os.totalmem()` (from `node:os`, imported at line 185)
   - Reports system-wide free/total; per-process values covered by `process.memoryUsage()`
   - Cost: <1ms, synchronous, no subprocess

3. **Swap** (macOS-specific):
   - **Native node solution**: None exists. `os.freemem()` doesn't report swap.
   - **Shell solution**: `sysctl -n vm.swapusage` outputs `total=13312M used=12319M free=992M`
   - **Cost at 15s interval**: ~5ms per sysctl call, negligible (<<0.1% CPU over 1h)
   - **Implementation**: Use `execSync('sysctl -n vm.swapusage', {encoding:'utf-8'}).trim().split(/\s+/)[1]` or wrap in try-catch
   - **Alternative considered**: `/proc/meminfo` (Linux only, not available on macOS)
   - **Robustness**: sysctl output format stable for decades on macOS; safe to parse

**Per-tick overhead estimate**:
- `process.memoryUsage()`: <0.1ms
- `os.freemem()`: <0.5ms
- `execSync('sysctl -n vm.swapusage')`: ~3–5ms
- `console.log()` (picked up by wrapper's ISO-timestamp monkey-patch): <0.5ms
- **Total**: ~5ms/15s = 0.03% CPU, well below 0.1% threshold [INFERRED from typical sysctl latency]

---

## D3: Existing RSS logging overlap

**Current state**:
- `[embed-loop:rss]` logs (line 3682) fire every `RSS_SAMPLE_EVERY` iterations (need to grep for definition)
- Logs only during embed-loop active iterations
- **Gap**: When backlog is empty or embed-loop is paused (e.g., circuit breaker open per line 3796), no RSS visibility until next work batch

**Grep result** (line 3681–3682): [CONFIRMED by read]
```
if (!C11_DISABLED && _rssSampleIter % RSS_SAMPLE_EVERY === 0) {
  const mu = process.memoryUsage();
  console.log(`[embed-loop:rss] ...`)
```

**Watchdog role**: Complements embed-loop logging by providing continuous heartbeat regardless of workload state. Without it, if the process is killed during an idle window (backlog drained, circuit open, discovery loop asleep), the last log line is from 5+ minutes prior — useless for diagnosing RSS at kill time.

**Example from investigation** (line 43–46 of 2026-04-23-vcontext-sigkill-137-investigation.md):
```
6799  23:48:30 iter=480 rss= 881MB  heap=73/157MB
6817  23:59:05 iter=510 rss= 387MB  heap=12/17MB   ← GC dropped (11 min gap)
6831  [wrapper] Server exited with code 137          ← kill (need RSS AT this line!)
```
Watchdog would have filled the 11-min gap with 44 snapshots.

---

## D4: Overhead

**Per-iteration cost**: ~5ms every 15s = 0.333ms avg (off-critical-path)  
**Relative to embed-loop work**: Embed-loop typically sleeps 100–5000ms between iterations (depends on batch size, MLX latency). Watchdog's 5ms is shadow noise.  
**Process lifetime impact**: `.unref()` ensures no lifecycle extension.  
**Logging I/O**: Writes to stdout, same channel as existing loops. Line buffered by default; 15s interval keeps throughput <1 line/sec (10× less than normal embed-loop output during active backlog).

**Conclusion**: Overhead negligible. Can safely add without performance risk.

---

## D5: Kill-evidence design (post-mortem capture)

**Next phase** (P0e, out of scope for this audit):
- On restart, scan `/tmp/vcontext-server.log` tail for the last `[watchdog]` line before the exit marker
- Write a structured `kill-post-mortem` entry to vcontext containing:
  ```json
  {
    "exit_code": 137,
    "last_watchdog_rss": "234MB",
    "last_watchdog_swap_used": "12.3GB/14GB",
    "last_watchdog_timestamp": "2026-04-23T00:13:34.890Z",
    "wrapper_exit_lag_ms": 45
  }
  ```
- This entry can be queried via `/recall?q=kill-post-mortem` to surface kill-time evidence in the dashboard

**Scope decision**: Watchdog *output* (this audit) is P0d. Post-mortem *capture* (parsing + structured storage) is P0e, separate work.

---

## D6: macOS-specific considerations

**`sysctl vm.swapusage` stability**:
- Output format: `total=13312M used=12319M free=992M` (space-separated key=value pairs)
- Stable for ≥15 years across OS X 10.5 through macOS Sequoia (empirically reliable)
- Safe to parse with `split(/\s+/)` or regex

**System-wide vs per-process**:
- `os.totalmem() / os.freemem()`: Report system-wide kernel view (accurate for compression, compressor pages, etc.)
- `process.memoryUsage().rss`: Per-process footprint (what we actually care about for RSS budget)
- Both needed: rss shows whether *this* process is the victim; sys_free shows whether *pressure* is the environment

**Import requirement**: `os` module already imported at line 185, so no new import needed.

---

## D7: Sample log output

**Three consecutive ticks (45 seconds of data)**:

```
2026-04-23T09:50:00.000Z [watchdog] rss=234MB heap=89/156MB ext=4MB sys_free=980MB swap_used=12.3GB/14GB
2026-04-23T09:50:15.000Z [watchdog] rss=240MB heap=91/156MB ext=4MB sys_free=972MB swap_used=12.4GB/14GB
2026-04-23T09:50:30.000Z [watchdog] rss=238MB heap=90/156MB ext=4MB sys_free=968MB swap_used=12.5GB/14GB
```

**Readability**:
- One-liner format compatible with existing `[tag]` log convention
- Sortable by ISO timestamp (machine-readable first)
- Greppable: `grep '\[watchdog\]'` returns all snapshots
- Parseable: space-separated key=value pairs (compatible with awk/jq)

**Log size estimate**: 1 line per 15s = 5760 lines/day. At ~80 bytes/line (uncompressed), ~460 KB/day or ~14 MB/month per process. Acceptable for a RAM disk + /tmp spillover scenario.

---

## Implementation sketch (text only, not committed)

Location: **vcontext-server.js, after line 10507**

```javascript
// ── Memory watchdog: 15s RSS/swap snapshot for kill-evidence ──
function startMemoryWatchdog() {
  const { freemem, totalmem } = require('node:os');
  const { execSync } = require('node:child_process');
  
  setInterval(() => {
    try {
      const mu = process.memoryUsage();
      const sysFree = Math.round(freemem() / 1048576);
      const sysTotal = Math.round(totalmem() / 1048576);
      let swapUsed = '?', swapTotal = '?';
      try {
        const swapLine = execSync('sysctl -n vm.swapusage', {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 2000
        }).trim();
        // Parse: "total=13312M used=12319M free=992M"
        const m = swapLine.match(/used=(\d+)M.*total=(\d+)M/);
        if (m) { swapUsed = m[1]; swapTotal = m[2]; }
      } catch { /* sysctl failed or timed out */ }
      
      console.log(
        `[watchdog] rss=${Math.round(mu.rss/1048576)}MB ` +
        `heap=${Math.round(mu.heapUsed/1048576)}/${Math.round(mu.heapTotal/1048576)}MB ` +
        `ext=${Math.round(mu.external/1048576)}MB ` +
        `sys_free=${sysFree}MB swap=${swapUsed}MB/${swapTotal}MB`
      );
    } catch (e) {
      console.error(`[watchdog] snapshot failed: ${e.message}`);
    }
  }, 15000).unref();
}

// Call at startup, after server.listen() fires:
startMemoryWatchdog();
```

**Notes**:
- Wraps sysctl in try-catch; graceful fallback to `?` if unavailable (e.g., under non-macOS)
- `.unref()` ensures no lifecycle extension
- Timeout on sysctl (2s) prevents hang if system under extreme load
- Uses same `console.log` channel as existing code; wrapper's monkey-patch adds ISO timestamp

---

## Summary & P0d recommendation

| Dimension | Finding |
|-----------|---------|
| **Insertion point** | `server.listen()` callback, line 10507 (after `_startupCompleteAt`) |
| **Data** | rss, heap used/total, external, sys_free, swap_used/total |
| **Frequency** | 15s interval, 5ms/tick overhead |
| **Overhead** | ~0.03% CPU, no lifecycle impact (`.unref()`) |
| **Overlap risk** | Low; complements embed-loop logging by filling idle-window gaps |
| **macOS compat** | `sysctl vm.swapusage` stable; `os.*` module available; ready to implement |
| **Log format** | One-liner, ISO timestamp, space-separated key=value pairs |
| **Kill-evidence impact** | Closes observation gap in pre-death state; enables P0e post-mortem capture |

**P0d ACCEPT**: Implement watchdog loop per sketch. Low risk, high signal-to-noise, unblocks P0e post-mortem investigation pipeline.

---

*Audit by subagent, 2026-04-23 14:30 JST. Sources: vcontext-server.js (lines 1–10514), vcontext-sigkill-137-investigation.md, live log /tmp/vcontext-server.log.*
