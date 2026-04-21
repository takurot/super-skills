# Next-Session Kickoff — 2026-04-22

*Session 905f38bd (2026-04-21 evening) resolved the recurring SIGKILL-137
pattern. Root cause was wrapper.sh:99-100 `wait_server_bound()` 120s
timeout firing because server startup couldn't bind port 3150 within 120s
— the underlying reason was slow DB startup on a 9 GB primary.sqlite
(WAL replay + FTS5 load + recovery) + hourly backup cycle competing with it.
Fix: embedding JSON→BLOB migration + VACUUM shrank DB 17.1 → 7.1 GB;
H10 (backup → block) + H12 (shutdown ramDb.close()) now both resolved.*

---

## Session-start ritual (5 min)

```
# Baseline (fill in at start)
BASELINE_CRASHES=$(grep -c "exited with code 137" /tmp/vcontext-server.log)
BASELINE_TIME=$(date)
echo "Baseline: $BASELINE_CRASHES crashes at $BASELINE_TIME"

# Health checks
curl -sS http://127.0.0.1:3150/health | grep -q healthy && echo "vcontext OK"
curl -sS http://127.0.0.1:3161/health | grep -q healthy && echo "mlx-embed OK"

# Size sanity (should be MUCH smaller than pre-2026-04-21)
ls -la ~/skills/data/vcontext-primary.sqlite ~/skills/data/vcontext-ssd.db | awk '{printf "%s: %.2f GB\n", $NF, $5/1024/1024/1024}'
# Target: both ~3.5 GB, not 8.5+

# Recent backup success?
tail -3 /tmp/vcontext-backup-external.log
# Target: "backup OK: size=... duration=..." within last hour

# Disk
df -h ~/skills/data | tail -1
# Target: >20 GiB free

# Regression signal — re-run at end of session
# NEW=$(grep -c "exited with code 137" /tmp/vcontext-server.log); echo "delta: $((NEW - BASELINE_CRASHES))"
```

If primary.sqlite is back at 8+ GB, backup logs "server unreachable", or
crashes delta > 0 during session → embedding write path or wrapper timeout
regressed.

---

## What shipped 2026-04-21 (4 key commits)

```
913cbb0 (14:36)  fix(server): H12 — shutdown setTimeout FIRST + skip ramDb.close()
21210f8 (19:01)  feat(server): POST /store content size guard (1 MiB, env-tunable)
5321311 (20:16)  feat(server): entries.embedding JSON→BLOB migration + decodeEmbedding helper
7d3c02a (prior)  tune: embed loop wait 50ms→500ms  [prior session tail]
```

Plus data / filesystem actions (not commits):
- VACUUM primary.sqlite (8.54 → 3.55 GB) and ssd.db (8.60 → 3.55 GB)
- Migration: 103,485 embeddings JSON→BLOB, 1,783 skipped (768-dim legacy)
- Disk cleanup: +40 GiB total (corrupt orphans + snapshots + premigration + stale backups)
- Backup rotated: old vcontext-backup.sqlite deleted, new 3.55 GB generated cleanly
- 1,783 legacy 768-dim embeddings NULLed for re-embed (see §Cleanups below)

---

## Root cause established

**H10 + H12 are BOTH real, both needed fixing.**

### H10: hourly backup on oversized DB → watchdog/wrapper SIGKILL

Observed pattern (3/3 correlation on 2026-04-21 afternoon):
- 16:59 / 18:01 / 19:03 backup cycles each crashed server ~3 min later
- Each left 8+ GB backup-tmp orphans swept at next startup
- After DB shrunk to 3.55 GB: 20:21 backup completed in 30s, zero crashes

### H12: shutdown path blocked by ramDb.close()

Commit 913cbb0 message: shutdown handler ran setTimeout() AFTER ramDb.close(),
but ramDb.close() could block if a backup was in progress (ramDb connection
held by backup). Fix: setTimeout FIRST (sets kill timer), THEN try to close
ramDb (best-effort). Prevents SIGTERM→indefinite hang→SIGKILL-137.

### DEFINITIVE SIGKILL source (audit 2026-04-21)

All 6 SIGKILL-137 events on 2026-04-21 traced to:
**`/Users/mitsuru_nakajima/skills/scripts/vcontext-wrapper.sh:99-100`**
— `wait_server_bound()` 120s timeout. `kill -9 "$pid"` fires when
server doesn't bind port 3150 within 120s of startup.

NOT the source:
- Watchdog force-restart path (lines 194-197): requires
  `VCONTEXT_RESTART_ON_HEALTH_FAIL=1`, which is NOT set anywhere
- OS jetsam / memory pressure: no evidence in kernel logs
- Backup process directly: only triggers the chain, not the killer

Fix path: shrink DB so startup (WAL replay + FTS5 load + sqlite-vec init)
completes well within the 120s window. Currently ~45-60s on 3.55 GB DB.

### Prior hypotheses re-classified
- H5 (mlx-embed retry storm): RESOLVED by C11 (prior session, 2026-04-20)
- H6 (MLX-generate loop pileup): FALSIFIED (Agent 3 re-run 2026-04-21)
- H7 (KV cache): partially fixed, not a current driver
- H8 (predict handler reentrant): likely PHANTOM (0 "handler entered" in recent logs)
- H9 (disk-full + APFS CoW): CONFIRMED (3 corrupt files created today before cleanup)
- **H10 (backup cycle trigger): CONFIRMED** — primary trigger post-H5
- **H12 (shutdown ramDb.close() block): CONFIRMED** — the actual kill mechanism was wrapper timeout firing during shutdown stall

---

## Current state

| Component | State |
|---|---|
| vcontext-primary.sqlite | 3.55 GB (was 8.54), integrity ok, 186,425 rows |
| vcontext-ssd.db | 3.55 GB (was 8.60), integrity ok, 186,408 rows |
| vcontext-backup.sqlite | 3.55 GB (fresh 20:21, 30s cycle, integrity ok) |
| vcontext-vec.db | 1.65 GB (unchanged, binary already) |
| SIGKILL-137 count | 6 (all pre-cleanup or during VACUUM transition) |
| Disk free | ~26 GiB |
| com.vcontext.server | running, clean |
| com.vcontext.backup | re-enabled 20:21, hourly |
| com.vcontext.mlx-generate | still launchctl-disabled (untouched) |

---

## Remaining work (prioritized)

### Near-term cleanups
1. **1,783 legacy 768-dim entries (DONE 2026-04-21)** — NULL swept, awaiting
   mlx-embed backfill with 4096-dim. Re-verify count with:
   ```
   sqlite3 ~/skills/data/vcontext-primary.sqlite \
     "SELECT COUNT(*) FROM entries WHERE embedding IS NULL AND type NOT IN ('working-state','anomaly-alert','pre-tool','session-recall','test');"
   ```
   Should drop to ~embed-backlog level over time.

2. **Other field size guards** — per Agent A security review:
   - tags array length cap (no current guard, JSON bomb vector)
   - reasoning / conditions byte cap
   - session / namespace format whitelist
   ~50 LOC across handleStore().

3. **BLOB API response check** — `/recent?short=false` confirmed returns plain array.
   But EXTERNAL clients relying on JSON-string embedding need notification.
   Likely none currently — grep ecosystem scripts for confirmation.

### Mid-term (deferred)
4. **Parameterized SQL queries** (esc() → .prepare().run(bindings))
   92 call sites in vcontext-server.js. HIGH severity per Agent A.
   Plan: start with /store then spread. Separate branch.

5. **HTTP slow-loris / rate limit**
   Server has NO requestTimeout, headersTimeout, or per-IP rate limit.
   ~30 LOC, MED severity.

### Next-feature work
6. **Autonomous-agent skill (Path A confirmed by user)**
   Vision: Devin-風 long-running autonomous tasks, parallel, AIOS-native
   (claude-api + scheduled-tasks + SKAP v1, local-first but eventually cloud).
   Design start: read `scripts/aios-task-runner.js` (already exists, processes
   task-request/task-status-update/task-result entries).

### Pre-existing (pre-2026-04-21)
- SKAP Phase E: POST /aios/lessons write-path (HITL-gated) + MCP stdio bridge
- C9 H3: buildRouteTable HTTP cutover (Option A vs B decision pending)
- LLM recovery: enable mlx-generate. 4h SIGKILL-137=0 soak now feasible
  with H10+H12 fixed (wait for soak window to validate).

---

## Do NOT do these (2026-04-21 lessons)

- **Do not revert BLOB migration** without testing backup cycle works on
  the resulting 8+ GB DB. Regression would re-open H10 kill chain.
- **Do not put synchronous I/O in shutdown path** — H12 fix exists
  specifically to prevent SIGTERM→ramDb.close()→hang→SIGKILL.
- **Do not remove `wait_server_bound` timeout** — it's correct safety; the
  fix is making startup faster, not removing the guard.
- **Do not run VACUUM while server is up** — VACUUM takes exclusive lock,
  blocks event loop → wrapper timeout fires → SIGKILL chain revives.
  Always `launchctl bootout` first.
- **Do not re-enable `com.vcontext.backup` on a DB larger than ~5 GB**
  without first checking disk headroom > 2× DB size. H9 disk-full
  corruption mechanism re-activates under pressure.
- **Do not call `ramDb.backup()` synchronously** — must be worker_thread
  per Stage 4.5 C5 (`eff19aa`), or event loop stalls 20+ seconds.
- **Do not trust "MLX-generate disabled" as meaning it's safe to re-enable
  without AC-R1/R2 gate** — proxy respects disable via is_service_disabled
  check, but enabling adds 6 GB RAM pressure; verify soak first.

---

## Decisions captured this session

- **AIOS principle clarification** (user-authored):
  "Local-only is a phase, not a rule. Future = network → cloud → infinite growth."
  Stored at `~/.claude/projects/-Users-mitsuru-nakajima-skills/memory/feedback_aios_principle.md`.
  Implication: don't reject cloud integrations on "local principle" grounds.

- **Devin 風 integration path = A (AIOS 内製)**:
  Build autonomous-agent skill using claude-api + existing task-runner + SKAP.
  Not via external SaaS (privacy, cost, skill-internalization reasons).

- **L2 loop memory gate: SKIP** (Agent 3 re-run verdict 2026-04-21):
  Real crash driver was backup (now fixed), not MLX loop concurrency.
  Only 2 data points for H6, which was falsified.
  Keep `docs/specs/2026-04-21-c11-l2-loop-memory-gate-draft.md` as reference,
  do not ship unless crashes resume despite backup fix.

---

## Rollback paths

- **entries.embedding BLOB → JSON**: `node scripts/migrations/embedding-blob-to-json.mjs`
  (~3 min + VACUUM again for file shrink)
- **fts5 size guard**: revert commit 21210f8
- **H12 shutdown fix**: revert 913cbb0
- **Backup re-enable**: already on. To disable: `launchctl bootout gui/501/com.vcontext.backup`
- **Combined rollback (all 3 shipped today)**: revert 5321311 → run reverse
  migration → revert 21210f8 → revert 913cbb0. Order matters.

## Recovery points available

- vcontext-primary.sqlite (current, healthy, 3.55 GB)
- vcontext-backup.sqlite (2026-04-21 20:21, 3.55 GB, integrity ok)
- snapshots/daily-20260421-0754.db (2026-04-21 16:54, 8.8 GB, pre-migration state)
- vcontext-vec.db (1.65 GB, all embeddings in binary — independent of entries.embedding)
- **Worst-case**: even with all DBs lost, vec.db has all embeddings and
  can be used to reconstruct the embedding column.

---

*End of 2026-04-21. Server stable, backup cycle restored, embedding storage
modernized. Next session: pick from near-term cleanups (#2 field guards, #3
BLOB client audit) or jump to autonomous-agent design (Path A).*
