# Silent-catches structuring — tiered remediation proposal

Date: 2026-04-22 late evening JST
Scope: READ-ONLY inventory + 4-tier classification. No edits tonight.
Targets: `scripts/vcontext-server.js` (10 505 lines), `scripts/vcontext-hooks.js` (3 401 lines).
Method: AST-aware scan via `/tmp/catch_scan.js` + `/tmp/catch_context.js` (balanced-brace matcher that skips strings/comments — more accurate than the briefing's regex grep).

## 1. Full-count inventory (all catches, both files)

| Category | server.js | hooks.js | Total |
|---|---:|---:|---:|
| **Silent** (`catch {}` or `catch (e) {}` with empty body) | 137 | 84 | **221** |
| **Comment-only** (`catch { /* note */ }`) | 51 | 4 | **55** |
| **Log-only** (console.log/warn/error only, no recovery) | 54 | 7 | **61** |
| **Action** (recovery / fallback / rethrow) | 144 | 28 | **172** |
| **Total** | **386** | **123** | **509** |

Silent + comment-only = **276 / 509 = 54%**. The briefing's "134 / 161 = 83%" counted a subset (likely `catch (e) {}` style with param, only in server.js) — this full scan is broader and more accurate.

## 2. Silent catches clustered by operation

Of the 276 silent + comment-only catches:

| Operation | Count | Severity baseline |
|---|---:|---|
| `other` (control flow / local parse / misc) | 74 | Varies |
| `db-op` (dbExec, dbQuery, prepared-stmt run) | 63 | **High if under-logged** |
| `json-parse` (user-supplied blobs) | 54 | **Medium** — drops data silently |
| `fs-mutate` (unlink/rename/mkdir) | 25 | Low (idempotent cleanup) |
| `json-stringify` (typically vec sync or DB write) | 16 | **High if in a write path** |
| `fs-read` (non-mandatory configs / pos files) | 12 | Low |
| `signal` (process.kill / exit) | 9 | Medium |
| `shell-exec` (execSync osascript notifs) | 8 | Low |
| `fs-write` (pos-file, flag, queue writes) | 7 | **Medium** (write failures lost) |
| `close` (db.close / socket destroy in shutdown) | 5 | Low |
| `http-op` | 2 | (all comment-only, mlx metrics) |
| `ipc` | 1 | Low |

## 3. Proposed 4-tier classification

### Tier A — KEEP-AS-SILENT (harmless, expected)
**Estimated count: ~90 (33%)**
- `fs-mutate` cleanup where ENOENT is expected (25): `fs.unlinkSync` for stale tmp, `renameSync` of sidecars. Examples: `vcontext-server.js:411`, `:442`, `:960`, `:1010`, `:1021`.
- `close` in shutdown paths (5): `vcontext-server.js:10409` (client.socket.destroy), `:10417-18` (vecDb/ssdDb.close).
- Comment-only "non-fatal" paths where author already reasoned about it (55): `:134` backup file append, `:851` CLOUD_CONFIG_PATH read (optional), `:611` `[object Object]` cleanup.
- `shell-exec osascript` notifications (8): OS dialog is decoration, not a hard path. `:4322`, `:4326`, `:4337`, `:4368`.
- **Rule of thumb**: if the try-body is an idempotent side-effect where failure literally means "already done" or "user has notifications off", silent is correct.

### Tier B — UPGRADE-TO-LOG (should at least record)
**Estimated count: ~110 (40%)**
- `json-parse` (54): if a row's `content` / `tags` / `consensus` field is malformed, we silently fall through to `[]` but have no record. Worth a single `errorLog('json-parse-failed', ...)` or 1-in-N sample. Examples: `:3081`, `:3096`, `:4632`, `:4659`, `:4756` (chunk summary parsing), `hooks.js:260` (error-log line parse), `hooks.js:1076` (skill-registry parse).
- `fs-write` (7) in hooks: writing position files / flags / queue files. A silent failure means position-tracking drifts. `hooks.js:169`, `:1413`, `:1505`, `:1519`, `:1820`.
- `fs-read` (12): pos files read. If parse fails we default 0 which re-scans from start — operationally OK but worth logging if it keeps happening. `hooks.js:40`, `:252`, `:1385`.
- `signal` / `db-op` in background maintenance loops (subset): silent failure of `backfillIndex`, `detectAnomalies`, `startup` migrations is indistinguishable from success in logs. `:729`, `:3903`, `:4008`.

### Tier C — NEEDS-REAL-HANDLING (swallowing masks real bugs)
**Estimated count: ~55 (20%)**
- Silent catches inside `/store` embed path (`:1636` "Non-fatal"): wraps the whole async embed write. If `writeEmbeddingBlob` or `vecUpsert` throws, the row is in an inconsistent state (embedding written to one place but not another, or `entry_index.has_embedding` flag wrong). This directly masks the "60 620 backlog but ECONNREFUSED not retried" issue in the pre-existing MLX audit.
- `json-stringify` inside DB-write paths (16): `:5493` vecUpsert, `:5588` vecSync, `:5117` skill-creation. If this throws, the vector is **silently not indexed** — user searches will get stale recall.
- `db-op` inside loops that count successes: `:3770-72` backfillIndex trio (`writeEmbeddingBlob`/`vecUpsert`/`entry_index update` — 3 silent catches in a row, each can skew the claimed-success count vs actual state).
- Silent catches covering the MLX `/ai/status` path: the 5s cold start / 174 ECONNREFUSED errors in today's audit live behind exactly this pattern (see §4 Q2).

### Tier D — ROUTE-TO-SKILL-TRIGGER (unusual / high-impact)
**Estimated count: ~20 (7%)**
Should mirror commit `28fa60a`'s pattern: emit `skill-trigger` so next session applies `investigate`/`careful`.
- DB recovery failures masked silently: `:411` unlink after corruption detection — if the unlink itself fails the DB file stays corrupt and startup loops.
- VACUUM/salvage silent failures during db-recovery: `:437`, `:442`, `:9188`, `:9279`.
- IPC/watchdog failure: `:324` `parentPort.postMessage('ping')` — if the main loop can't ping the watchdog thread, the watchdog will SIGKILL the process; silent here means we can't distinguish deliberate stop from ping-channel breakage.
- Backup rename failures in paths where the backup is the recovery target: `:1010-23` (BACKUP_PATH rename/unlink). Silent here in the backup critical section matches the pattern the 2026-04-22 incompleteness audit flagged for "Tier-1 self-healing is partial".

## 4. Analysis questions

### Q1 — whack-a-mole pattern?
git blame on 11 silent catches sampled across the file: commits span `2026-04-11 … 2026-04-20`. All authored by the same user. The commit messages are **feature commits** (`feat: index layer`, `feat: consultation broker`, `feat: cross-project knowledge`) and one perf commit (`perf(server): yield event loop`). **Not** reactive crash-fix commits. Conclusion: silent-catch is the **house style**, not whack-a-mole. This is actually worse news — it means new features ship with silent catches by default, so the count grows with feature velocity. One corroborating artifact: the surviving comment at `vcontext-server.js:5931` ("previously a silent catch{} hid transient 30s MLX restart windows from observability") shows the author knows the pattern is harmful but has not generalized the fix.

### Q2 — do silent catches hide known MLX issues?
Yes, two direct hits:
- `vcontext-server.js:1636` (`} catch {} // Non-fatal`) wraps the `/store` setImmediate embed write. The inner `catch (e) { console.log('[store] MLX embed failed: ...') }` at `:1625` catches `mlxEmbed` only; the outer silent catch covers `writeEmbeddingBlob` and `vecUpsert`. The 174 ECONNREFUSED errors come from the inner (logged), but any subsequent failure to record the partial-write state is lost. No retry, no recovery — rows are silently inserted without embeddings. This **is** the mechanism behind "backlog grew +58 in 3 h" from today's MLX audit.
- `/ai/status` 5-s cold start path: the probe at `:5930` now has explicit streak logging (fixed earlier today), but the *comment* at `:5931-32` documents that the previous silent catch hid exactly this. Several sibling probes still swallow silently (e.g., `:4318-19`, `:4337` macOS DB-errors notification).

### Q3 — 5-item minimum viable improvement
If only 5 silent catches are fixed, pick the highest signal-per-effort:

1. **`vcontext-server.js:1636`** — `/store` embed outer catch. Convert `catch {}` → `catch (e) { errorLog('store-embed-post', e.message); metrics.incr('store-embed-post-fail') }`. Directly gives us visibility into the backlog mechanism. **~5 LOC.**
2. **`vcontext-server.js:5493`** — `vecUpsert` silent catch. If this fails, vector recall is silently broken for that row. Convert to `errorLog('vec-upsert-fail', { id, msg: e.message })`. **~3 LOC.**
3. **`vcontext-server.js:3770-72`** — `backfillIndex` trio (3 sequential silent catches). Replace with a single structured per-row result. Today we claim "X rows backfilled" with no way to detect partial writes. **~10 LOC.**
4. **`vcontext-server.js:324`** — watchdog `parentPort.postMessage('ping')` silent. If this fails the watchdog will SIGKILL. Emit a `skill-trigger` on failure. **~4 LOC, Tier D pattern.**
5. **`vcontext-hooks.js:55`** — the `errorLog` writer itself has a silent catch. If the error log can't be written, we have no way to know. A single `console.error` fallback prevents "silently losing the logging substrate". **~2 LOC.**

Estimated total: ~24 LOC, ~30 min effort, unlocks real visibility into the MLX backlog, vec index integrity, watchdog ping-channel, and the error-logging substrate itself.

## 5. Effort rollup for the 4-tier plan

| Tier | Count | Treatment | Effort |
|---|---:|---|---:|
| A KEEP | ~90 | None (document in CONVENTIONS as OK-to-ignore) | 0 LOC |
| B LOG | ~110 | Replace with `errorLog(kind, detail)` (hooks.js:51 helper already exists; mirror into server.js) | ~220 LOC (~2 per site) |
| C HANDLE | ~55 | Retry / fallback / explicit state-transition + metric | ~550 LOC (~10 per site) |
| D TRIGGER | ~20 | `emitSkillTrigger(kind, keywords, rationale)` — reuse 28fa60a pattern | ~80 LOC (~4 per site) |
| **Total** | **~275** | | **~850 LOC** |

Phasing: top-5 tonight/tomorrow → Tier D batch (mirrors 28fa60a work, high value) → Tier C critical (MLX backlog + vec integrity) → Tier B bulk (can be scripted). Tier A untouched.

## 6. Reconciliation

Reconciled: **509 catches parsed** across 2 files (13 906 total LOC), **11 git-blame spot-checks**, **8 catch sites read in full context**, **1 cross-doc reference** (2026-04-22-preexisting-mlx-pipeline-issues.md), **1 commit reference** (`28fa60a` for the Tier-D pattern). **Full-count inspected** — no sampling.
