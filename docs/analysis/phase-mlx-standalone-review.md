# Phase Review — MLX Embed Standalone Verification & Audit

*Phase N = verification + independent audits + 10-min consistency monitoring.*
*Phase N+1 = production cutover (gated by this review + FINAL monitor PASS).*

Generated 2026-04-22 19:01 JST, session 28d38f34.

## Goal

Promote `scripts/mlx-embed-server-standalone.py` (wrapped in
`apps/MLXEmbedServerStandalone.app`) to production LaunchAgent, replacing
the directly-launched Python server, so jetsam properties shift from
`category=daemon, priority=40` to `category=app, priority=100`.

## Artifacts evaluated (line-count proof of full read)

| File | Lines | Purpose |
|---|---:|---|
| `scripts/mlx-embed-server.py` | 952 | Production baseline (untouched) |
| `scripts/mlx-embed-server-standalone.py` | 868 | mlx_lm-free refactor |
| `apps/MLXEmbedServerStandalone.app/Contents/MacOS/MLXEmbedServerStandalone` | 37 | Bash wrapper (logging + cwd + exec python) |
| `apps/MLXEmbedServerStandalone.app/Contents/Info.plist` | 18 | Bundle descriptor (LSBackgroundOnly, LSUIElement, CFBundleIdentifier=com.vcontext.mlx-embed-standalone) |
| `docs/handoff/2026-04-22-mlx-standalone-rollback.md` | 217 | Promote/rollback procedure |
| `/tmp/mlx-cutover.sh` | 164 | Automated cutover (8 steps, syntax checked) |
| `/tmp/mlx-consistency-monitor.sh` | 61 | 10-iter × 60s monitor |
| `/tmp/mlx-consistency-monitor.log` | 8+ | Live results (appends) |
| `/tmp/mlx-embed-server.log` | 31,741 | Production log (observability working) |
| `/tmp/mlx-embed-server-standalone.log` | 59 | New log (wrapper redirect verified working) |

All files read in full. No truncation.

## Agent results consolidated

### Agent 1 — Quality-gate verifier (conversation-embedded, read in full)

Ran 8 checks. Full-count summary:

| # | Check | Result | Note |
|---|---|---|---|
| 1 | Route coverage | 10/10 match | initial awk missed multi-line decorators; line-aware re-verify corrected. |
| 2 | Pydantic schemas | 7/7 match field-level | EmbedRequest/EmbedResponse/BatchEmbedRequest/BatchEmbedResponse/HealthResponse/OllamaEmbedRequest/OpenAIEmbedRequest |
| 3 | Response field diff | identical | `/api/health` `backend` value cosmetic diff ("mlx" → "mlx-standalone") |
| 4 | Tokenizer edge cases | 16/16 match (re-run by main) | 1st-pass fstring syntax error; fixed and re-verified 16 patterns bit-identical ids + mask |
| 5 | Load-path edge case | **REGRESSION → FIXED** | resolve_model_dir raised on cache-miss; added huggingface_hub.snapshot_download fallback (heavy-deps-free verified) |
| 6 | Cache logic | identical | cap=500, key format, eviction all same |
| 7 | Nuitka build | FAILED (libmpdec scan bug) | dropped in favour of bash-wrapper .app approach (this phase's key pivot) |
| 8 | Production cache-bug | KNOWN-EXISTING (not regression) | cos=0.5548 single→batch mismatch; spawned as separate task |

### Agent 2 — Risk investigator (conversation-embedded, read in full)

Three investigations:

| # | Investigation | Verdict | Action taken |
|---|---|---|---|
| 1 | Nuitka + MLX Metal runtime | HIGH RISK — build failed on libmpdec; .app had no MLX/tokenizer payload | PIVOTED away from Nuitka to bash-wrapper .app (confirmed sufficient for cat=app) |
| 2 | LaunchAgent → open → cat=app | Agent said MEDIUM-HIGH risk (predicted cat=daemon based on launchctl print examples) | **FALSIFIED by empirical test**: bash-script .app launched via `open -W -n -a` from LaunchAgent gives `spawn_type=app(1), cat=app, pri=100`. Agent's theory was wrong; test .app is registered as `application.*` via runningboardd. |
| 3 | Model architecture audit | LOW RISK — 15 config keys ignored equally, RoPE identical for rope_scaling=null, sanitize identical, shard() unused for single-device, attention deliberately bidirectional | No action required |

### Agent 3 — Cutover risk auditor (conversation-embedded, read in full)

Sections A/B/C analysed. Key findings:

- **A Cutover plan**: produced simplified new plist (drops Nice/ProcessType/LowPriorityIO/Env/WorkingDirectory/StandardOutPath — all confirmed no-op when Program=/usr/bin/open). Kept Label/ProgramArguments/RunAtLoad/KeepAlive/ThrottleInterval.
- **B vcontext-server downstream**: MLX_EMBED_URL→3161, has 120s circuit-breaker + 2s health timeout + 2min unavailable-mode keep-alive. Estimated cutover-window impact: 130-190s degradation if batch in-flight; ~5s port-free otherwise.
- **C Crash-recovery plan**: produced dry-run script (not executed — would interfere with live monitor). Identified: python=orphan PPID=1 by design (LaunchServices/runningboardd pattern). Launchd watches `/usr/bin/open` wrapper; if python crashes, `open -W` should exit → launchd restarts via KeepAlive=SuccessfulExit=false → new open → new python.

## Empirical evidence captured (hard numbers)

### Jetsam category verification

| Process | spawn_type | category | priority | via |
|---|---|---|---|---|
| Production `com.vcontext.mlx-embed` | interactive (4) | daemon | 40 | `launchctl print gui/501/com.vcontext.mlx-embed` |
| Chrome (user GUI) | app (1) | app | 100 | `launchctl print gui/501/application.com.google.Chrome.*` |
| Finder | app (1) | app | 100 | same |
| Test JetsamTestApp (bash-script .app, experiment 1) | app (1) | app | 100 | same |
| **New .app `application.com.vcontext.mlx-embed-standalone.*`** | **app (1)** | **app** | **100** | same |

### Memory limits

All categories (including production `cat=daemon` and new `cat=app`) show
`jetsam memory limit = unlimited`. Only Activity Monitor had a 800MB
soft limit. Finder had 1600MB soft limit. Our workload unaffected.

### Consistency monitoring — FINAL 10/10 OK, 0 FAIL

```
iter=1  18:55:35  cos=1.0000000000  prod_rss=230  new_rss=154  OK
iter=2  18:56:34  cos=1.0000000000  prod_rss=217  new_rss=79   OK
iter=3  18:57:32  cos=1.0000001192  prod_rss=235  new_rss=78   OK
iter=4  18:58:36  cos=1.0000000000  prod_rss=230  new_rss=76   OK
iter=5  18:59:33  cos=0.9999998808  prod_rss=230  new_rss=76   OK
iter=6  19:00:31  cos=1.0000000000  prod_rss=234  new_rss=76   OK
iter=7  19:01:29  cos=1.0000000000  prod_rss=230  new_rss=76   OK
iter=8  19:02:27  cos=1.0000001192  prod_rss=232  new_rss=76   OK
iter=9  19:03:24  cos=1.0000000000  prod_rss=232  new_rss=76   OK
iter=10 19:04:22  cos=1.0000001192  prod_rss=225  new_rss=77   OK
FINAL oks=10 fails=0
```

All 10 iterations PASS. cos range [0.9999998808, 1.0000001192] (±1.2e-7
fp32 JSON round-trip noise). Both servers RSS stable (production 217-235
MB, new 76-77 MB — new is lower because mmap model weights are accounted
primarily to the first-touching process).

### Security audit (S1-S6, agent 4)

| S# | Area | Severity | Verdict |
|---|---|---|---|
| S1 | Bash wrapper injection | LOW | `eval`=0, backticks=0, `$(...)`=3 (all safe). No user-controlled argv. Single-user machine — no /tmp symlink attack surface. |
| S2 | LaunchServices bundle-id squatting | LOW | 1 registration (ours). plist uses `-a <path>` not `-b <id>`, so path-resolved regardless. |
| S3 | huggingface_hub auto-download | LOW | repo_id constant in plist, no runtime user input. HF uses HTTPS+TLS. No signature verification for safetensors/tokenizer.json (MED theoretical but gated on plist write). Cache warm → download not triggered on cutover. |
| S4 | Port binding scope | MED (pre-existing) | Both servers bind 127.0.0.1 correctly. CORS `*` + no auth + 127.0.0.1 → DNS-rebinding class risk exists but is parity-with-production, not introduced by this refactor. Tracked as a future hardening task. |
| S5 | Crash-recovery loop edge | MED (documented) | `exec` replaces bash PID, so python IS the process `open -W` watches. SIGSEGV triggers KeepAlive-SuccessfulExit=false correctly. Edge case: if `open` crashes while python orphan holds port → launchd re-fires but new python bind-fails → stuck loop until manual orphan kill. ThrottleInterval=10 caps churn. |
| S6 | Phase review gaps | — | Added: security section, crash test script, final monitor data. Persist /tmp/mlx-consistency-monitor.sh to git post-cutover (non-blocking). |

**BLOCKING issues**: NONE  
**NON-BLOCKING** (post-cutover): tighten CORS to `["http://localhost","http://127.0.0.1"]`, pin HF revision SHA, persist monitor script to git, run crash test 10+ min post-cut.

### Quality / precision benchmark (T1-T5, 2026-04-22 19:11 JST)

User-requested verification that cutover does not degrade quality:

| Test | production 3161 | new 3162 | Verdict |
|---|---|---|---|
| T1 single-shot p50 | 233.3 ms | **180.6 ms** | 23% FASTER |
| T1 single-shot p95 | 871.3 ms | **242.5 ms** | 72% FASTER (tail improved) |
| T1 single-shot mean | 329.5 ms | **214.3 ms** | 35% FASTER |
| T2 10× concurrent total | 2095 ms | 1621 ms | 23% FASTER |
| T3 batch(8)×5 p50 | 1081 ms | 1013 ms | 6% FASTER (within noise) |
| T4 top-3 recall on 10-doc corpus | [1,7,8] scores [0.7305, 0.5079, 0.5063] | [1,7,8] same | **IDENTICAL** |
| T5 /v1/embeddings keys | {data, model, object, usage} | same | **IDENTICAL** |

Conclusion: quality equal or better on every axis. Latency improvements likely due to the simpler code path (no mlx_lm abstraction layer).

### Memory shift audit (agent 5, pre-cutover)

- Per-process true physical footprint: **4.1-4.8 GB** (vmmap), not ~100 MB as ps RSS suggests. `ps RSS` under `open -W` wrapping severely under-reports because many pages are in compressed/swapped state.
- System swap: **14.86 / 16 GB used (93%)** — high pressure.
- Prediction after prod dies:
  - Shared mmap pages (safetensors ~3.4 GB): **no re-accounting**, just freed.
  - IOAccelerator per-process (4 GB DIRTY): **freed entirely** (4.3 GB wired drops to ~4 GB for new server alone). Net memory **relief**.
  - New .app first embed request: 5-10 s (swap-in of 4 GB IOAccelerator pages). Subsequent requests: normal latency (already measured in T1 as 180 ms p50).
- Cutover script updated 2026-04-22 19:12:
  - Smoke test timeout 10s → 30s (accommodates first-request swap-in).
  - `autorollback()` helper added; step 5/6/7/8 failures now auto-restore prod plist + kill orphan + restart + verify /health, instead of leaving user stranded.
  - Manual rollback hint includes `pkill -KILL -f mlx-embed-server-standalone.py`.

### Phase N+1 entry gate — ALL CRITERIA MET

- [x] 10-min monitor FINAL 10/10 OK, 0 FAIL
- [x] Evidence file complete (this file)
- [x] Cutover script syntax-clean (196 lines; auto-rollback added)
- [x] New plist shape plutil-lint PASS
- [x] .app Info.plist plutil-lint PASS
- [x] Rollback doc updated (bash-wrapper pattern + orphan handling)
- [x] Quality/precision verified no-regression (actually improved)
- [x] Memory-shift prediction documented

Green-lit for Phase N+1 (cutover) pending user explicit go.

## Reconciliation (quantitative, per quality-gate rule)

- **Routes**: Reconciled 10 of 10 match, 0 differences.
- **Schemas**: Reconciled 7 of 7 match field-level, 0 differences.
- **Tokenizer edges**: Reconciled 16 of 16 match ids+mask bit-identical, 0 differences.
- **Embed single-shot HTTP**: Reconciled 5 of 5 match cos≥0.9999998808, 0 FAIL.
- **Embed batch (cache-miss via nonce)**: Reconciled 5 of 5 match cos≥0.9999999404, 0 FAIL.
- **Embed batch (cache-hit)**: Reconciled 5 of 5 match cos≥0.9999999404, 0 FAIL.
- **Post-fix regression embed**: Reconciled 5 of 5 match cos≥0.9999999994, 0 FAIL.
- **10-min live monitor**: Reconciled 7 of 10 so far (3 pending); 7 of 7 PASS so far.

Total test cases: 55+ executed, 0 FAIL, 0 regressions introduced.

## Issues & remediation status

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | Load-path regression: resolve_model_dir crashed on cache-miss | Medium | **FIXED** — huggingface_hub.snapshot_download fallback added; heavy-deps footprint verified 0 |
| 2 | Nuitka build fails on libmpdec dependency scan | — | **AVOIDED** — pivoted to bash-wrapper .app; Nuitka not needed for cat=app |
| 3 | `open -W` child python PPID=1 (orphan) on unload | Low | **DOCUMENTED** — cutover script includes explicit kill step for test-app unload (per audit Q3) |
| 4 | Production embedding cache pollution (single vs batch) | Medium | **SPAWNED** — separate task; pre-existing bug, both servers same behaviour, not regression of this refactor |
| 5 | Log forwarding broken via `open -W` | High (pre-fix) | **FIXED** — wrapper script redirects stdout/stderr to /tmp/mlx-embed-server-standalone.log; verified 59 lines captured after fix |
| 6 | CWD mismatch (.app child starts at /) | Low | **FIXED** — wrapper script `cd /Users/mitsuru_nakajima/skills` before exec |
| 7 | Nice=-20 does not propagate from plist to .app via runningboardd | Low | **ACCEPTED** — new .app runs at nice=0. Jetsam pri=100 is primary stability gain; CPU nice regression minor (MLX latency dominated by GPU+memory). Documented in wrapper comment. |
| 8 | Downstream vcontext-server circuit-breaker during cutover outage | Medium | **DOCUMENTED** — 130-190s degradation worst-case; cutover script minimises window to ~5s normal / ~60s if batch in-flight |

## Decision gate for Phase N+1 (cutover execution)

Permit cutover if ALL of:
- [ ] 10-min monitor reports FINAL 10/10 OK (currently 7/10, 3 pending)
- [x] Evidence file saved (this file)
- [x] cutover script bash syntax PASS
- [x] new plist plutil -lint PASS
- [x] .app Info.plist plutil -lint PASS
- [x] rollback doc updated with actual .app pattern
- [x] production plist backup directive in place (`.bak-YYYYMMDD-HHMMSS` naming)

Block cutover if ANY of:
- Any single monitor iteration shows cos < 0.9999
- Either server PID disappears during monitor
- Production log shows `ERROR` outside of expected patterns
- vcontext-server starts showing mlx failure streak

## If FINAL PASS → run cutover

```bash
/tmp/mlx-cutover.sh 2>&1 | tee /tmp/mlx-cutover-$(date +%Y%m%d-%H%M%S).log
```

Post-cutover verification (embedded in script):
- curl /health on 3161 → `"status":"healthy","model_status":"ready"`
- curl /api/health → `"backend":"mlx-standalone"`
- launchctl print application.* label → `cat=app pri=100`
- /api/embeddings smoke test → `dim=4096`

Rollback remains one command: `cp <.bak-*> <plist> && launchctl unload/load`.

## If FAIL → hold

Keep production as-is. Diagnose failure, update standalone or .app wrapper,
re-run 10-min monitor.

---

*Phase N review status: PENDING FINAL MONITOR (7/10 PASS so far)*
