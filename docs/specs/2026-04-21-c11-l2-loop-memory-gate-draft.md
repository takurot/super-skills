# C11 L2 — Loop Memory Gate (pre-baked draft, not deployed)

*Pre-baked implementation sketch for L2. Kept as doc rather than
commit so we only deploy IF the 30-min observe window confirms
H6 crash class is still active. Deploy decision: user H2.*

## Requirements (1-liner)

Gate discovery / chunk-summary L1/L2/L3 / predict loops behind the
same memory-pressure check the proxy uses (edb06c4). If available
memory < threshold, skip this tick with a log line. Loops are
idempotent — next tick will retry.

## Design

### Helper (add near top of server.js, after any vm_stat usage)

```js
// C11 L2 (2026-04-21): memory-pressure gate for MLX-generate
// consumer loops. Mirrors the proxy's check from edb06c4:
// Pages free + Pages inactive = available-without-swap. 
// MIN_AVAILABLE_PAGES = 50000 (~800 MB) matches proxy's MIN_FREE_PAGES.
// Loops skip-with-log when under threshold; they are all idempotent
// (next tick retries), so data loss is zero.
//
// Rollback: VCTX_LOOP_MEMGATE_DISABLED=1 disables the check.
const MIN_AVAILABLE_PAGES = parseInt(
  process.env.VCTX_LOOP_MIN_AVAILABLE_PAGES || '50000', 10
);
const _LOOP_MEMGATE_DISABLED = process.env.VCTX_LOOP_MEMGATE_DISABLED === '1';

async function _loopMemGate(loopName) {
  if (_LOOP_MEMGATE_DISABLED) return { ok: true };
  try {
    const { stdout } = await execFileP('vm_stat', [], { timeout: 2000 });
    const mFree = stdout.match(/Pages free:\s+(\d+)\./);
    const mInactive = stdout.match(/Pages inactive:\s+(\d+)\./);
    const free = mFree ? parseInt(mFree[1], 10) : 0;
    const inactive = mInactive ? parseInt(mInactive[1], 10) : 0;
    const available = free + inactive;
    if (available < MIN_AVAILABLE_PAGES) {
      console.log(`[${loopName}:memgate] skipping tick — available=${available} pages (${Math.round(available*16384/1048576)}MB) < min=${MIN_AVAILABLE_PAGES} (${Math.round(MIN_AVAILABLE_PAGES*16384/1048576)}MB)`);
      return { ok: false, available };
    }
    return { ok: true, available };
  } catch {
    // Can't measure → fail-open (per AIOS P3 principle).
    return { ok: true, available: null };
  }
}
```

### 3 wiring sites

Each loop has a main `while` body that calls MLX-generate at some
point. Gate the call by adding ONE `if (!(await _loopMemGate(...)).ok)`
check immediately before the `mlxGenerate()` (or equivalent) call.

**A. runDiscovery** (line ~4050+, grep for `[vcontext:discover]`)

```js
// Before: await mlxGenerate(...)
// After:
if (!(await _loopMemGate('vcontext:discover')).ok) {
  await new Promise(r => setTimeout(r, DISCOVERY_INTERVAL_MS));
  continue;
}
await mlxGenerate(...);
```

**B. runChunkSummaryOnce** (line ~4143+)

```js
// Before generating summary:
if (!(await _loopMemGate('chunk-summary')).ok) {
  // don't advance windowStart; next tick will retry same window
  continue;
}
```

**C. runOnePrediction** (grep for `runOnePrediction`)

```js
// Before the MLX generate call:
if (!(await _loopMemGate('vcontext:predict')).ok) {
  // skip this prediction cycle
  return;
}
```

**L2 + L3 summary loops** (chunk-summary-l2, chunk-summary-l3):
same pattern as B. Lower cadence (30min / 60min) so memory pressure
is less likely to hit, but gate for consistency.

### LOC estimate

- Helper: ~25 LOC
- 5 gate-site insertions: ~8 LOC × 5 = 40 LOC
- Rollback env gate + OpenAPI/docs: 0 (no endpoint change)

**Total**: ~65 LOC single-file change to `scripts/vcontext-server.js`.

## Rollback

`VCTX_LOOP_MEMGATE_DISABLED=1` in LaunchAgent env + restart. All
gates become no-ops, behavior returns to pre-L2.

## Test plan (if deployed)

1. Restart server, confirm `[embed-loop] C11 active` log line (as
   today — means env not broken)
2. Watch for `[*:memgate] skipping tick` log lines during actual
   memory pressure (stimulate by opening large apps briefly)
3. Monitor SIGKILL-137 over 30 min:
   - Target: 0 new crashes
   - If crashes continue → the gate isn't the right hammer; revert

## Commit message template

```
feat(server): C11 L2 — memory-pressure gate on MLX-generate loops

H6 (identified post-LLM-recovery): concurrent discovery +
chunk-summary + predict loops pile MLX-generate inference on the
single Qwen3-8B-4bit process → RSS spike → SIGKILL-137. Two
crashes observed (#135, #136) before this fix.

L2 adds the same free+inactive memory check the proxy uses to
gate bootstrap (edb06c4), but at each MLX consumer loop entry.
When available < 800 MB, the loop skips this tick with a log
line; next tick retries. Loops are idempotent so zero data loss.

Rollback: VCTX_LOOP_MEMGATE_DISABLED=1.

Verified: SIGKILL-137 total $BEFORE → $AFTER over 30-min post-
deploy window. Target: 0 new crashes; H6 confirmed resolved.

Depends on: edb06c4 proxy memoryGate fix (same formula).
```

---

## Conditional deploy decision

- **IF** observe pulse at T+30min shows `SIGKILL-137 total > 136`:
  → H6 confirmed active, deploy L2
- **IF** `SIGKILL-137 total == 136` (stable):
  → H6 may have self-resolved, L0 / close session is defensible
- **IF** agent 3 (`a4482f27bfad80b3e`) suggests cheaper alternative:
  → consider single-inflight lock or cadence tuning instead
