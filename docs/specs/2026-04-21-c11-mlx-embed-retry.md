# C11 — mlx-embed retry semantics (memory-pressure mitigation)

*Created 2026-04-20 late evening after root-cause discovery in
`docs/analysis/2026-04-20-nightly-organic-crash-pattern.md` §4b.
Level: **Spec-Anchored** — lives alongside code, evolves with it.*

---

## Requirements

### Goal

Stop the mlx-embed retry storm from pinning enough memory to
cause OS reclamation of SQLite mmap pages (→ "file is not a
database" errors → SIGKILL-137). Keep the embed-loop correct
(still drains the backlog eventually) while bounding its
worst-case memory footprint under MLX degradation.

### Acceptance Criteria

- **AC-C11-1**: During a sustained mlx-embed outage (e.g. MLX
  returns ECONNRESET continuously for ≥5 min), the server
  process RSS increases by ≤ 200 MB above healthy baseline.
  Measured by `ps -o rss= -p <pid>` sampled every 30 s.
- **AC-C11-2**: `[db query error] file is not a database` rate
  stays ≤ 10 per 30 min during MLX outage (was 631 per 30 min
  2026-04-20 pre-C11). Measured via `tail -c 524288
  /tmp/vcontext-server.log | grep -c 'file is not a database'`.
- **AC-C11-3**: After MLX recovers, embed-loop drains backlog
  at ≥ 5 embeddings/sec (empirical baseline: 8.07 emb/s at
  batch=16; allow 40% degradation margin for backlog-adaptive
  batch shrinking).
- **AC-C11-4**: Store path (`POST /store`) never blocks
  waiting for mlx-embed during MLX outage. Latency p95 for
  `/store` requests stays < 100 ms regardless of MLX state.
- **AC-C11-5**: Circuit breaker opens within 60 s of sustained
  MLX failure and closes within 120 s of MLX recovery (no
  perma-stuck states).
- **AC-C11-6**: First `[db query error]` after a clean run
  triggers a one-shot diagnostic that logs
  `PRAGMA integrity_check` result from ramDb. Confirms or
  falsifies the mmap-reclaim theory. Diagnostic output is
  idempotent — fires at most once per 30 min.

### Error cases (explicit)

| Case | Expected behavior |
|---|---|
| MLX returns ECONNRESET mid-batch | log once per streak escalation, back off per existing `backoffMs`, do NOT re-queue the batch (already handled via next iteration's SELECT) |
| MLX returns mismatched-length array | count as failure, existing path retained |
| MLX returns 4xx (e.g. rejected text) | mark the specific row's embedding as `[poisoned]` sentinel so next SELECT skips it; DO NOT spin on the same row forever |
| Backlog > 20000 | disable the embed loop entirely for 10 min, log a single warning; resume automatically |
| Server receives SIGTERM during active batch | current batch completes or times out cleanly; no data corruption |

### Out of Scope

- Replacing MLX embed with a different backend
- Changing the model (Qwen3-Embedding-8B-4bit-DWQ stays)
- mlx-generate retry semantics (separate: Phase E / LLM recovery)
- WAL checkpoint tuning (documented separately if still needed
  after C11)

---

## Design

### Current state (observed 2026-04-20)

| Parameter | Value | Problem |
|---|---|---|
| BATCH | 16 (constant) | holds 16 × ~16 KB content buffers + 16 × 16 KB embedding buffers during the batch |
| `_mlxEmbedBatchRaw` timeout | 600 000 ms (10 min) | a single slow batch pins 512 KB of buffers for up to 10 min |
| `backoffMs(streak)` | 100ms → 30 s (cap) | ✓ correct, already exponential |
| Circuit breaker | via `mlxAvailable` flag + `checkMlx()` | checkMlx runs on its own timer; embed-loop doesn't re-check on error until next iteration |
| Store-path inline embed | `setImmediate(async () => mlxEmbed(...))` | already non-blocking for /store response, but queues an unbounded number of pending embed tasks during outage |
| Poisoned-row protection | safeSliceCodePoints + sanitizeEmbedText | addresses surrogate-pair issue, not MLX HTTP failures |

### Proposed changes

**D1 — Shorten batch timeout** (the biggest memory-retention
knob): 600 000 ms → 60 000 ms. MLX embed p99 is ~2 s in healthy
state; a batch taking >60 s is already pathological. Failing
fast frees the 512 KB buffer + lets the retry loop cycle.

**D2 — Backlog-adaptive batch size**: If current backlog
(`SELECT COUNT(*) WHERE embedding IS NULL`) exceeds 5000, drop
BATCH from 16 → 4. Rationale: during MLX degradation, smaller
batches mean smaller per-call buffers and faster feedback on
whether MLX recovered. The ≥ 5 emb/s AC is still achievable at
batch=4 (2 emb/s per worker × 3 workers post-recovery).

**D3 — Dedicated circuit breaker in embed-loop**: Add
`let circuitOpenUntil = 0` to the embed-loop scope. On streak
≥ 3, set `circuitOpenUntil = Date.now() + 120_000` and skip
the MLX call entirely for the next 2 minutes. After the window,
attempt one probe; on success, close the circuit and resume.
This prevents the 30-s-backoff retry from still holding
buffers every 30 s during a 10-min outage (currently it would
fire 20 times).

**D4 — Store-path circuit check**: When `circuitOpenUntil >
Date.now()`, the setImmediate callback in handleStore SHOULD
NOT call mlxEmbed. The row is stored without embedding; backlog
grows; embed-loop will pick it up after circuit closes. This
bounds the number of pending setImmediate tasks during outage.

**D5 — Poisoned-row sentinel**: If _mlxEmbedBatchRaw returns a
4xx HTTP status (not ECONNRESET, not timeout — actual rejection),
mark the offending row's `embedding` column to an impossible-
shape sentinel (e.g. JSON string `"[POISON]"`). Next
SELECT skips rows where `embedding IS NULL` (sentinel is not
null), so the row is out of the retry queue. Document the
sentinel and provide a one-shot cleanup endpoint.

**D6 — Backlog-cap guard**: `if (backlog > 20000) { skip loop
for 10 min }`. Prevents the loop from locking up the server's
CPU + memory during a catastrophic backlog event.

**D7 — mmap-reclaim diagnostic**: Wrap `dbQuery` so the FIRST
occurrence of "file is not a database" per 30-min window
triggers:
  ```js
  const check = ramDb.pragma('integrity_check', {simple: true});
  console.log(`[db-diag] first mmap-reclaim signal; integrity_check=${check}`);
  ```
Also snapshots `vm_stat` and process RSS at that moment.
One-shot per 30-min TTL. Confirms the H5 theory empirically.

### Data model

No schema changes. Uses:
- `entries.embedding` column: already nullable string; new
  sentinel value `"[POISON]"` is valid text
- `entry_index.has_embedding` column: set to -1 for poisoned
  rows (so it's distinguishable from 0 = still pending)

### API / Interface

No public API changes. Internal changes:
- `_mlxEmbedBatchRaw(texts)`: timeout param reduced; new
  optional `{timeoutMs}` arg for override
- `mlxEmbed(text)`: new optional `{skipIfCircuitOpen: true}` —
  used by store-path to respect D4
- New `circuitOpenUntil` state variable + helper
  `isEmbedCircuitOpen()` / `markEmbedCircuitOpen(durationMs)`

### Sequence (healthy steady state)

```
embed-loop: SELECT 16 rows → _mlxEmbedBatchRaw → UPDATE →
            sleep 100ms → repeat
/store: setImmediate → mlxEmbed → UPDATE
```

### Sequence (MLX degraded, C11-post)

```
embed-loop: SELECT 16 rows (backlog >5000 → 4 rows)
  → _mlxEmbedBatchRaw (60 s timeout) → ECONNRESET
  → consecutiveFailures=1 → backoff 1 s
  → SELECT 4 rows → _mlxEmbedBatchRaw → ECONNRESET
  → consecutiveFailures=2 → backoff 5 s
  → SELECT 4 rows → _mlxEmbedBatchRaw → ECONNRESET
  → consecutiveFailures=3 → CIRCUIT OPEN (120 s)
  → skip MLX, sleep 30 s, recheck circuit
  → ... (circuit closes after 120 s)
  → probe batch of 1 row → success → consecutiveFailures=0
  → resume normal cycle

/store (during circuit-open):
  setImmediate → isEmbedCircuitOpen() === true
    → SKIP mlxEmbed call entirely
    → row stays in backlog for loop to pick up
    → zero memory cost for this request
```

### Constraints

- No dependency on mlx-generate (keep that disabled path orthogonal)
- Don't change the existing batch=16 healthy throughput
- Rollback: `VCTX_EMBED_C11_DISABLED=1` env var skips all new
  logic, falls back to today's behavior. Required for the
  24-h soak-and-revert window.

---

## Tasks

- [ ] 1. Shorten `_mlxEmbedBatchRaw` timeout to 60 s (D1).
      Add `timeoutMs` override arg. Satisfies AC-C11-1 partial.
- [ ] 2. Add `circuitOpenUntil` state + `isEmbedCircuitOpen()`
      helper in embed-loop module scope (D3). Satisfies AC-C11-5.
- [ ] 3. Wire circuit check into embed-loop main path: streak ≥ 3
      opens circuit, skip MLX during window, probe at window-end
      (D3). Satisfies AC-C11-1, AC-C11-5.
- [ ] 4. Wire circuit check into store-path setImmediate
      callback (D4). Satisfies AC-C11-4.
- [ ] 5. Add backlog-adaptive batch size: SELECT count first,
      drop BATCH 16 → 4 if > 5000 (D2). Satisfies AC-C11-3.
- [ ] 6. Add backlog-cap guard: skip loop for 10 min if
      backlog > 20000 (D6). Satisfies AC-C11-3 worst-case.
- [ ] 7. Add poisoned-row sentinel for 4xx responses (D5).
      Update embed-loop SELECT to exclude sentinel rows. Add
      one-shot `POST /admin/embed-unpoison` to reset sentinels.
- [ ] 8. Add mmap-reclaim diagnostic wrapper in dbQuery
      first-error path (D7). Satisfies AC-C11-6.
- [ ] 9. Add env-var rollback gate `VCTX_EMBED_C11_DISABLED=1`.
- [ ] 10. Update OpenAPI for `/admin/embed-unpoison` (AC-8 sync).
- [ ] 11. Add TDD harness `scripts/test-c11-embed-retry.sh`
      covering:
      - timeout behavior (simulate slow MLX, confirm 60s abort)
      - circuit opens on streak ≥ 3
      - circuit closes after window
      - /store doesn't block during circuit-open
      - backlog-adaptive batch size change
      - mmap-reclaim diagnostic fires once-per-30min
- [ ] 12. Deploy, observe for 4 h, check SIGKILL-137 count delta
      (target: 0). Record in evolution-log.

### Estimated diff

~250 LOC across `scripts/vcontext-server.js` (single file).
Test harness ~150 LOC. One OpenAPI entry. Total ~400 LOC new.

Rollback LOC: 0 — env var gate means the pre-C11 behavior
is a code path controlled at runtime, not removed.

---

## Verification

After implementation:

1. Run `scripts/test-c11-embed-retry.sh` — all scenarios pass.
2. Disable mlx-embed (`launchctl disable com.vcontext.mlx-embed`)
   for 30 min; observe server RSS. Confirm ≤ 200 MB growth.
3. Re-enable mlx-embed; observe embed-loop drains backlog at
   ≥ 5 emb/s over 10 min window.
4. Grep 30-min log window: confirm ≤ 10 "file is not a database"
   entries.
5. Watch SIGKILL-137 count across a 4-h window — target: 0 new
   crashes.
6. Record result in
   `docs/analysis/2026-04-20-nightly-organic-crash-pattern.md`
   §9 "C11 outcome" (new section to be appended).

If any verification step fails, set `VCTX_EMBED_C11_DISABLED=1`
via environment, restart, and reopen investigation.

---

## Related artifacts

- Root cause analysis: `docs/analysis/2026-04-20-nightly-organic-crash-pattern.md`
- LLM recovery spec (blocked on this): `docs/analysis/2026-04-21-llm-recovery-spec.md`
- Existing backoff / code: `scripts/vcontext-server.js` §embedLoop (lines 3433-3584) + `_mlxEmbedBatchRaw` (lines 5244-5267)
- Spec of earlier Stage 4.5: `docs/specs/2026-04-21-stage-4.5-spec.md`
- Constitution P6 (Observe before act): `docs/principles/AIOS-CONSTITUTION.md`
