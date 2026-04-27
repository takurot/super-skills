# Changelog

## 2026-04-18 → 2026-04-27 — Stabilization, Constitution, M7

### Architecture

- **2026-04-20**: AIOS Constitution authored (`docs/principles/AIOS-CONSTITUTION.md`).
  4 axioms (AIOS is an OS for AI; AI evolves AIOS; co-evolution),
  6 principles (P1-P6), 4 HITL tiers (H1-H4). All future architectural
  decisions reference this document.
- **2026-04-20**: Loose-coupling backup process extraction. The in-process
  `doBackup()` was decoupled from the event loop, preventing SIGKILL
  cascades that previously caused 28 GB WAL runaway. Per
  `docs/specs/2026-04-20-true-loose-coupling-redesign.md`.
- **2026-04-21**: Stage 4.5 spec for eliminating residual `primary.sqlite`
  external callers (`docs/specs/2026-04-21-stage-4.5-spec.md`). 20 call
  sites identified across 9 files; cleanup pass to retire direct-to-SQLite
  in favor of HTTP via `vcontext-server`.
- **2026-04-21**: AIOS shared-knowledge access protocol
  (`docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md`) and
  `docs/principles/shared-knowledge-source-of-truth.md` — vcontext is
  the canonical store; local caches reference ids, not duplicate prose.

### Self-steering / hooks

- **2026-04-22**: Anomaly → skill-trigger reactive wiring (6 unconnected
  alerts now route to the trigger pipeline). Embedding-backlog metric
  split into eligible / skipped / raw for actionable observability.
- **2026-04-23**: Self-steering meta-loop spec
  (`docs/handoff/2026-04-23-aios-self-steering-spec.md`).
  M1-M7 mechanisms graduated from discipline to system enforcement.
  M1 lands as passive skill-invocation audit at session-end; M4 surfaces
  anomaly-driven skill triggers at bootstrap.
- **2026-04-24**: M2 phase-1 shadow hook (pre-claim evidence gate, log-only)
  and M5 session-end retrospective (log-only, daily-compounding).
- **2026-04-27**: M7 phase-2 hook deployed
  (`/Users/mitsuru_nakajima/skills/.claude/hooks/directive-recall.mts`).
  PreToolUse intercept for Edit/Write/NotebookEdit; queries vcontext for
  matching directive entries; injects nudge when value ≠ directive
  (no block).

### Stability

- **2026-04-22**: 2026-04-22 pre-existing MLX pipeline issues catalogued
  (`docs/analysis/2026-04-22-pre-existing-mlx-pipeline-issues.md`);
  ISO-8601 timestamps prepended to vcontext `console.*` for grep-able logs.
- **2026-04-23**: Silent-`catch{}` audit identified top-5; 4-of-5 fixed
  in `6bbf496` (top-1 was `eda4a95`: `/store` embedding persistence
  errors are now logged instead of swallowed).
- **2026-04-23**: P0a-d vcontext stability pass — jetsam priority 40→100
  (`cat=app` migration), Node heap 4096→2048 MB, mmap 256/128 → 64 MB
  per DB, 15s RSS/heap/swap watchdog probe.
- **2026-04-23**: Python runtime cutover 3.13.2 → 3.14.4 for both MLX
  Python services (`mlx-embed-server`, `mlx-generate-proxy/wrapper`).
  Slight transitive bumps; cp314 wheels verified.
- **2026-04-24**: mlx-proxy S1 — post-spawn JIT warmup + `/proxy/warmup`
  endpoint. mlx-proxy U3a — self-heal when `state=RUNNING` but backend
  dead. Embed P0c — `mlxEmbedFast` respects circuit breaker.
- **2026-04-26 → 27**: Reprocess pipeline (`feat(reprocess): per-entry LLM
  annotation for ALL 132K entries`); thinking mode ON,
  `max_tokens=32768→40960` per standing directive; multi-line content
  fix for `sqliteFetchOne`. Concurrency tuning landed at
  `prompt-concurrency=6`, `decode-concurrency=24` (after 8/32 502 storm).
- **2026-04-27**: AIOS source review found 50 issues across 3 dimensions
  (QA / security / stability) — see
  `docs/analysis/2026-04-27-aios-source-review.md`.
  CRITICAL: 7 (2 security RCE-class, 5 stability incl. unbounded
  MLX queue).
- **2026-04-27**: Phase 2.5 OS-policy spec
  (`docs/specs/2026-04-27-aios-os-policy.md`). 14 acceptance criteria
  across 8 groups (time / budget / data / failure / truth /
  self-knowledge / role / concurrency). Reframes ad-hoc fixes as
  policy-derived enforcement.
- **2026-04-27**: mlx-generate KV cache bounded
  (`scripts/mlx-generate-wrapper.sh`). Was: `--prompt-cache-size 8
  --prompt-cache-bytes 0` (unlimited). Now: `--prompt-cache-size 2
  --prompt-cache-bytes 1073741824` (1 GiB cap). Prevents jetsam SIGKILL
  observed at 03:18Z 2026-04-27.

### Standing directives (lessons-learned)

- **2026-04-23**: User directive established: "local LLM なので compute
  気にしない、品質優先、省略しない" → `maxTokens=40960` design intent
  (lesson-learned id=229441/229438). Must not be reduced without
  acknowledged_directive override.
- **2026-04-27**: Standing directive enforcement codified as AC-B4 in
  `docs/specs/2026-04-27-aios-os-policy.md` and runtime-enforced by
  the M7 hook.

### Documentation

- **2026-04-21**: Self-steering meta-loop M1-M6 handoff
  (`docs/handoff/2026-04-22-mlx-standalone-rollback.md` and adjacent).
- **2026-04-23**: Q1-Q5 decisions + adversarial audit
  (`docs/analysis/aab292e`).
- **2026-04-26**: Python 3.15 feasibility analysis — HOLD verdict
  (`docs/analysis/2026-04-26-python-3.15-feasibility.md`).
- **2026-04-27**: Orphaned `docs/SPEC.md` and `docs/PLAN.md` archived
  to `docs/archive/` (referenced deleted
  `ref/gstack` / `ref/everything-claude-code`).
- **2026-04-27**: This CHANGELOG entry (γ4 update).

### Known rot (carried forward)

- 72 self-evolve patches accumulating in `data/pending-patches/` with
  no consumer.
- `data/snapshots/` 17 GB without retention policy (AC-C1 to address).
- 14 manifest skills missing from FS (`spec-driven-dev`, `quality-gate`,
  ...). Investigation γ2 ongoing 2026-04-27.
- `scripts/vcontext-hooks.draft.mts` 7-day idle TS-strict migration draft.
- LaunchAgent cron clusters at 05/06/07/09:00.

## 2026-04-17

A single-day stabilization & performance sweep (80+ commits).
Highlights, grouped by theme.

### 🛡️ Data protection (defence in depth)

- Async SSD write-through with id alignment (`handleStore` wrapped in
  `setImmediate`) — no longer blocks HTTP response on SSD I/O.
- Append-only JSONL log at `data/entries-wal.jsonl` — SQLite-independent
  durable write log. Survives any DB-level corruption.
- `checkAndRecoverDb` — on startup, `sqlite3 .recover` salvages raw
  entries from a corrupt RAM DB, then restores from snapshot, then
  `INSERT OR IGNORE`s salvaged rows back. Verified E2E on a 1.8 GB DB
  (`docs/analysis/2026-04-17-recovery-e2e-verification.md`).
- 1-min `rawSyncTimer` — RAM→SSD entries catch-up timer separate from the
  heavier 5-min backup/migration tick. Loss window: 5 min → 1 min.
- `POST /admin/replay-wal` / `GET /admin/wal-status` endpoints —
  catastrophic-recovery tooling.
- RAM disk 4 GB → **6 GB** (`vcontext-setup.sh`); `wal_autocheckpoint`
  500 pages on both RAM and SSD DBs.

### ⚡ Performance

| Metric (24 h → current) | Before | After | Ratio |
|---|---|---|---|
| recall avg | 3184 ms | 642 ms | 5× |
| recall max | 25 040 ms | 2 787 ms | 9× |
| store max | 38 145 ms | 3 337 ms | 11× |
| recent max | 16 226 ms | 286 ms | **56×** |
| embed throughput | 0/min (stalled) | 45/min | — |
| dashboard bandwidth | 3.5 MB / refresh | 225 KB | 94% cut |
| `/ai/status` | 1199 ms | 682 ms | 1.8× |
| summarize latency | 15 765 ms | 1 472 ms | **91% faster** (Qwen3 `/no_think`) |

Root causes that turned out to share a shape (fixed in both places):

- `withMlxLock` serialized background batches behind user-facing queries
  — fixed in recall (`mlxEmbedFast`) and embed-loop (`_mlxEmbedBatchRaw`).
- Silent `catch{}` on MLX availability probes flipped flags to false
  permanently — fixed with hysteresis + logging in both `checkMlx` and
  `checkMlxGenerate`.
- Watchdog `pgrep -f "mlx-generate-server"` never matched the real
  `python3 -m mlx_lm.server` cmdline → perpetual restart loop every 60 s.

### 🐛 Bug fixes

- `truncated is not defined` in `/session/:id` — orphan var after pagination refactor
- `malformed JSON` flood on `/analytics/skill-effectiveness` — SQLite optimizer
  pushed `json_each` above the type filter; switched to pure-JS aggregation
- dashboard frozen at "Loading..." — `var recent` shadowed `const recent`
  from outer scope → parse-time SyntaxError; renamed + added `Cache-Control: no-cache`
- watchdog ran 3+ duplicate instances after reloads → added pidfile singleton
- MLX Generate memory threshold 8 GB was catching steady-state, flapping
  the server every 4 min → raised to 14 GB
- `entry_index` had 28 538 orphan rows (deleted-entries residue) — purged
  + added incremental sweep to the 5-min tick
- `/ai/status` was 6 full-table `COUNT(*)` scans → one `SUM(CASE)` aggregate

### 🧩 Features

- **Morning brief** at 09:00: `com.vcontext.morning-brief` LaunchAgent +
  `GET /admin/health-report?days=N` endpoint + macOS notification +
  optional Slack/Discord webhook
- **Anomaly auto-response** (`respondToAnomalies`): per-kind handlers for
  embed-stall / ram-ahead / ram-disk-full / error-spike with 5-min cooldown
  and `type='anomaly-response'` audit trail
- **Dashboard Data Protection card** — JSONL WAL size, fill %, and the
  defence-in-depth chain explainer
- **Dashboard labels** — metric values now distinguish lifetime vs
  period (`N entries total (Xms/write · 24h)`, `Y queries/24h`, skills
  `registered (N lifetime, M in 24h) K matches/24h`)
- **`npm test` smoke suite** — 25 shape-asserting checks catch regressions
  like the truncated bug in < 5 s
- **`scripts/pre-outage.sh`** — one-command pre-shutdown data-safety checklist
- **Anomaly detection +3**: latency regression vs 7d baseline / DB write
  error count in recent log / embed backlog growth

### 🏷️ Rename: super-skills → infinite-skills

Internal auto-routing skill renamed across all 5 deploy targets
(claude / codex / cursor / kiro / antigravity). Earlier `auto-router`
residue (skill-registry DB row, manifest entries, server fallbacks)
also cleaned up.

*Preserved:* `scripts/sync-upstream.sh` still references `takurot/super-skills`
(external GitHub repo — not a skill name).

### 🔧 Operational

- **Watchdog tunables via env vars** — `VCONTEXT_MLX_GEN_MAX_MB`,
  `VCONTEXT_RAM_WARN_PCT`, etc. Ops can tune thresholds without code edits.
- **Module-split pattern established** — `scripts/lib/vcontext-utils.js`
  with pure helpers (esc, ftsQuery, estimateTokens, parseTags) as a
  proof-of-concept for future extraction (MLX client, DB layer, route
  handlers).
- **Snapshot pruning** — `data/snapshots/` 12 GB → 5.6 GB (kept
  initial-os + daily + pre-reboot).
- **RECOVERY.md** — runbook for cold-start, corrupt-RAM recovery,
  catastrophic-DB-loss, crash-loop, watchdog-flap, MLX-deadlock,
  RAM-disk-full scenarios.

### 📊 Tooling

- `experiment-thinking-skip.sh` — A/B harness measuring Qwen3 `<think>` cost
- `smoke-test.sh` — 25 endpoint shape checks + JS parse validation
- `pre-outage.sh` — 9-step data-safety checklist
- `vcontext-morning-brief.sh` — daily health digest generator
