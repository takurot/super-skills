# vcontext-server Incompleteness Audit — 2026-04-22

Independent architecture review. READ-ONLY. Evidence-first per `investigate` skill.

## 1. Executive summary

vcontext-server is **functionally up but operationally incomplete**: detection is well-developed (13 distinct `alerts.push` sites, live anomaly scan every 5 min), but remediation covers **only 4 of the 11 anomaly kinds** it raises. The other 7 are write-only log lines or DB entries with no code path that reconciles the underlying state. This matches the user's assessment.

Live evidence at audit time: **60,605 rows in embed backlog** (`/ai/status` live), two tiered subsystems explicitly stubbed (`cloudStore`, `federation/route`), and `[vcontext:alert] launchd 2 service(s) unhealthy` firing **9× in the last 200 log lines** with no corresponding `[anomaly-response]` line. Combined with the D6 issues main agent already surfaced (DESC-only embed ordering starving old rows), this is "alerts as telemetry, not as control". The system observes; it does not self-heal outside a narrow set of four canonical incidents.

Net assessment: vcontext is ~70% of the way to the tiered-memory vision stated in the file header. Tier-3 (cloud) is a pure stub. Tier-1/Tier-2 self-healing is partial. Alerting is mature but under-wired. No single finding is CRITical on its own, but the **composition** is: a backlog starvation plus silent launchd failure plus stub cloud means the "memory substrate" claim is not yet met.

## 2. Incompleteness inventory

| # | Location | Symptom | Evidence | Sev | Effort |
|---|---|---|---|---|---|
| 1 | server.js:3715-3720 | Embed loop uses `ORDER BY id DESC LIMIT 16`; old rows never drain | 60,605 current backlog vs ~78/min embed rate. No aging window. | HIGH | S |
| 2 | server.js:4124, 4236-4277 | `Embed backlog growing` alert fires but `respondToAnomalies` has no branch for it | alerts.push branch exists; switch has no `embed-backlog-growing` case | HIGH | S |
| 3 | server.js:4135-4172 | `launchd-unhealthy` alert logs + DB-writes, zero remediation action | Log shows 9 `[vcontext:alert] launchd ... unhealthy` in last 200 lines with ONE `[anomaly-response] Forced RAM→SSD sync` (wrong kind) | HIGH | M |
| 4 | server.js:845-890, 2012-2016, 2670-2676, 2776 | `cloudStore` is a stub: upload/search/download all return `{uploaded:0, error:'not yet implemented'}` | File header line 25 advertises "Cloud (cold)" but 3 call sites are no-ops | MED | XL |
| 5 | server.js:7269 | `/federation/route` tiers (haiku/sonnet/opus) all route to local MLX | Comment: "For now: all tiers go to local MLX (stub for future external)" | MED | L |
| 6 | server.js:4183-4197 | `doBackupAndMigrate slow` and `Tick interval jitter` alerts raised; no response branch | switch has only error-spike/embed-stall/ram-ahead/ram-disk-full | MED | M |
| 7 | server.js:4199-4217 | `MLX embed p95 regression` alert raised; no response branch | Same switch, no branch for latency regression | MED | M |
| 8 | server.js:4107-4110 | `DB errors in recent log` alert raised; no branch (only suggests "check for corruption or schema drift") | Same switch gap | MED | L |
| 9 | server.js:4078-4092 | Generic `Latency regression` (3× baseline) alert raised; no response branch | Same switch gap | LOW | M |
| 10 | server.js:5817-5846 | `checkMlxGenerate` keeps probing :3162 (mlx-generate) on a 60s cadence even when streak ≥3 unavailable; logs "Probe failed" repeatedly | `mlx_generate_available=false` live. No circuit breaker; re-probes forever. Log emits "Probe failed" every flip. | LOW | S |
| 11 | server.js:134 occurrences | Silent `catch {}` blocks — 134 empty catches out of 161 total catches = **83% error swallow rate** | `grep -c "catch\s*\([^)]*\)\s*\{\s*\}"` = 134; total catches 161 | LOW | L |
| 12 | server.js:110-126 | WAL queue overflow drops lines write-only; no flow control upstream | `_walDropped` counter only logged every 100 drops; no back-pressure to writers | LOW | M |
| 13 | server.js:6037-6097 | `/ai/status` does 1 aggregate query (already optimized 1.2s → 200ms) but still hits full table scan on every call; no TTL cache | Comment admits "was 1.2s"; no cache layer above | LOW | S |

## 3. Per-dimension findings

### D1 — Alert-without-remediation (13 alerts vs 4 branches)

`alerts.push` sites: **13**. `respondToAnomalies` switch branches: **4** (error-spike, embed-stall, ram-ahead, ram-disk-full). Gap = **9 alerts with no automated response**, of which 7 are raised by `runAnomalyScan` and 2 are snapshot-verify alerts (server.js:7486-7488).

Live verification from log: `launchd-unhealthy` fires its own `[vcontext:alert]` line via a side-channel (server.js:4170) but never enters `respondToAnomalies` because its alerts.push happens outside the `alerts` array passed to `respondToAnomalies` (server.js:4167-4172 writes DB directly, doesn't accumulate into the outer alerts). Current log pattern: unhealthy alert followed by "anomaly-response: Forced RAM→SSD sync" — the two are **unrelated** and the user-visible symptom is a false "we responded" signal.

### D2 — TODO / FIXME / stubs

- `// Cloud upload not yet implemented` (server.js:865)
- `// Cloud search stub returns [] for now` (server.js:2014)
- `// stub — no cloud entry count available yet` (server.js:2675)
- `_note: 'Cloud storage is not yet implemented'` (server.js:2776)
- `// For now: all tiers go to local MLX (stub for future external)` (server.js:7269)
- `// backup target not yet implemented` in help text (server.js:7157)
- `'not_implemented'` listed as valid vacuum status (server.js:8464)

Six distinct stub sites. No `TODO:` markers anywhere in server.js — but 7 `stub`/`not yet implemented` comments. Main file has **zero `FIXME`/`XXX`/`HACK`**, which is itself a signal: known problems are expressed in prose comments rather than tracked markers, making them hard to enumerate without manual reading.

### D3 — Silent catch blocks

- Empty `catch (e) {}` or `catch {}`: **134**
- Total catches (`catch (...)`): **161**
- Ratio: **83% swallow**. Most are in db-write, launchctl probe, execSync best-effort paths. Defensible for "best-effort telemetry" (WAL writes, osascript notifications), but risky for data-path writes (e.g., `vecUpsert`, `writeEmbeddingBlob` failures at server.js:3770-3772 are silenced — an embedding write-failure will NOT retry and the row stays `embedding IS NULL`, feeding back into the backlog alert).

### D4 — Incomplete subsystems

- **Tier-3 cloud** (stubbed — 4 sites above, header line 25 advertises it)
- **Federation tiers** (haiku/sonnet/opus all → local MLX)
- **Backup-target vacuum** (not implemented, 7157)
- **Predicted/discovery loops** gate on `mlxGenerateAvailable` (server.js:4004, 4322) — currently false live, so discovery is idle

### D5 — Live log alerts (200-line window)

```
[vcontext:alert] launchd 2 service(s) unhealthy: article-scanner exit=2, article-scanner-evening exit=2  ×9
[vcontext:alert] 2 anomalies detected  ×9 (corresponds to ram-ahead + launchd-unhealthy)
[anomaly-response] Forced RAM→SSD sync  ×9 (only remediation path firing)
```

Current firing: one alert kind **never** auto-remediated (launchd dead), one kind constantly triggering rapid-fire remediation (ram-ahead) — both are symptoms of the SAME underlying backlog problem, but treated as separate events.

### D6 — User-visible symptoms without acknowledgment

- **60k backlog starvation**: server.js:3710-3720 claims "Fresh first — user's recent context is most likely searched" — a **design choice, not an oversight**. But no comment acknowledges that old rows never drain when write rate ≥ embed rate. No LIMIT window for aging.
- **/ai/status 200ms**: server.js:6039-6041 acknowledges the prior 1.2s problem, but no cache added.
- **:3162 dead probe spam**: server.js:5817-5846 — no circuit breaker; probes forever on 60s cadence.
- **store-path ECONNREFUSED**: server.js:6019-6020 has a transient-retry list (3 delays) inside `mlxGenerate`; but embed-loop (server.js:3729-3763) deliberately bypasses `withMlxLock` and does its own retry via the circuit breaker. Different retry semantics in two paths — inconsistency is a latent bug surface.
- **No log timestamps until today**: still no in-process timestamp injection — relies on wrapper.

## 4. Prioritized remediation list

**P1 — Embed loop fairness** (server.js:3715-3720). Acceptance: add a second query path that picks oldest un-embedded rows 20% of cycles (or aged >24h always). Backlog should drain toward zero over a week, not grow monotonically. **Effort: S**.

**P2 — `embed-backlog-growing` response branch** (server.js:4236-4277). Acceptance: add case that calls `launchctl kickstart` on mlx-embed AND enables fairness mode above. Cooldown 15 min. **Effort: S**.

**P3 — `launchd-unhealthy` remediation** (server.js:4135-4172, 4236-4277). Acceptance: add branch that calls `launchctl kickstart -k "gui/$UID/com.vcontext.<label>"` for each dead agent, with 2-strike policy (don't kickstart on first alert — could be legitimate shutdown). Include in outer `alerts` array so cooldown works uniformly. **Effort: M**.

**P4 — Decide cloud tier: implement or remove** (server.js:845-890 + all reference sites). Acceptance: either (a) implement S3/R2 uploader with idempotent object keys and an integration test, or (b) remove from file header line 25 and delete `cloudStore` / all three call sites. "Stub" is worse than either direction because it implies a plan that does not exist. **Effort: XL implement / S remove**.

**P5 — `:3162` circuit breaker** (server.js:5817-5846). Acceptance: after streak ≥10 failures, increase probe interval from 60s → 15min. When HTTP 200 returns, reset. Stops log noise without losing detection. **Effort: S**.

## 5. Reconciliation

- **Read**: ~650 lines across 8 targeted ranges of vcontext-server.js (10,389 LOC total)
- **Grepped**: 7 distinct pattern families across vcontext-server.js + vcontext-hooks.js (3,032 LOC)
- **Confirmed**: 13 `alerts.push` sites, 4 `respondToAnomalies` branches, 134 silent catches, 9 live `launchd-unhealthy` alerts in recent log, 60,605 backlog live, `mlx_generate_available=false` live
- **Not inspected**: vcontext-hooks.js clean on TODO (0 matches), skipped deeper because it's a thin client not the server-of-record
- **Files**: `/Users/mitsuru_nakajima/skills/scripts/vcontext-server.js`, `/Users/mitsuru_nakajima/skills/scripts/vcontext-hooks.js`, `/tmp/vcontext-server.log`

Word count: ~1,570 (under 2,000 budget).
