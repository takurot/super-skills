# P0A cat=app cutover — READ-ONLY risk audit (vcontext-server)

Audit of: cutover `com.vcontext.server` LaunchAgent from direct
`/bin/bash vcontext-wrapper.sh` to `/usr/bin/open -W -n -a
apps/VContextServer.app`, mirroring yesterday's MLX-embed pattern.
Every claim cites file:line + verbatim quote.

## R1 — wrapper.sh compatibility with `.app` supervision

### R1.1 cleanup trap (SIGTERM/SIGINT/EXIT)
`scripts/vcontext-wrapper.sh:41-49`:
```
cleanup() { if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" ...; fi
            rm -f "$PID_FILE"; rm -f "$WRAPPER_LOCK"; exit 0; }
...
:115  trap cleanup SIGTERM SIGINT EXIT
```
Under `.app`: launchd's stop signal hits `/usr/bin/open`, not the
wrapper. `open -W` forwards SIGTERM to the LaunchServices-spawned
process group per macOS convention, but bash-as-app runs **inside**
LaunchServices, so TERM delivery to the wrapper is [INFERRED]
indirect at best. Yesterday's MLX doc at
`docs/handoff/2026-04-22-mlx-standalone-rollback.md:127` says
`# Kill orphan python from the .app pattern (PPID=1 by design)` —
i.e. the child becomes a launchd orphan, so `open -W` does **not**
take it down on stop. The cutover script `/tmp/mlx-cutover.sh:34-42`
explicitly `kill -TERM`s and then `-KILL`s the python by name
because `launchctl unload` alone leaves it running.

**Severity: MEDIUM.** Cleanup trap may not fire on normal stop;
`$WRAPPER_LOCK` and `$PID_FILE` can be stale on next load. But
`:15-23` already handles stale locks (`kill -0 "$OTHER"` + "taking
over"), so steady-state self-heals. First-cutover load may briefly
show "taking over" even though no prior wrapper actually survived.

### R1.2 reload (SIGHUP)
`:116 trap reload SIGHUP` + `:51-62 reload()`. SIGHUP is raised
today only by humans / scripts; **no production script uses it** —
`scripts/vcontext-reload.sh:6` = `launchctl kickstart -k`,
`scripts/vcontext-deploy.sh:127` = same, `scripts/vcontext-abtest.sh:89,92`
= same. So SIGHUP reaching the wrapper is not a cutover regression.
`launchctl kickstart -k` on the `.app` plist kills the root `open`
process; whether the bash+node descend also die is controlled by
runningboardd. Per R1.1 they don't — so `kickstart -k` will need a
post-kill pgrep sweep added to `vcontext-reload.sh`
[NEW-REQUIREMENT for cutover].

**Severity: HIGH for reload, but mitigatable** by patching
`vcontext-reload.sh` to `pkill -f vcontext-server\.js` after
kickstart, same pattern as `/tmp/mlx-cutover.sh:34-42`.

### R1.3 wrapper-lock semantics
`:15-24` — PID file sentinel. Works the same inside `.app`: bash's
`$$` is still the wrapper PID, `kill -0` still probes it. No
regression.

## R2 — node process / `open -W -n -a` interaction

`open -W` exits when the `.app`'s LaunchServices registration
terminates, not when any descendant dies. Bash wrapper is the
`CFBundleExecutable`, so when bash exits `open -W` returns.
**But** the node child spawned by `$NODE "$SERVER" &`
(`:106`) is backgrounded and becomes PPID=launchd on bash exit
(identical to yesterday's python PPID=1 pattern per
`docs/handoff/2026-04-22-mlx-standalone-rollback.md:127`).

Implications:
- **Node crash → bash `wait $PID` returns → `:158-172` restart
  loop re-runs.** Unchanged from today.
- **Bash crash → launchd restarts `open`, which spawns a new bash,
  but the old node is still on port 3150.** `wait_port_free`
  (`:64-78`) kills it (`kill -9 "$STRAY"`). Unchanged.
- **Stop via `launchctl unload`:** node is not a child of `open`,
  so `unload` frees port slower than today. `/tmp/mlx-cutover.sh:34-46`
  already shows the 15-second wait-loop needed.

**Severity: LOW** — behavior is known and handled by `wait_port_free`.

## R3 — port 3150 bind race during cutover

`vcontext-wrapper.sh:64-78` iterates 10s max; if 3150 still bound
by a non-wrapper PID, it sends `kill -9`. **This works inside the
new `.app`** because it uses `lsof`, not process-tree lookup.

The cutover itself (unload-old → load-new) is the riskier moment.
MLX-embed cutover logged "port 3161 free after Ns" at
`/tmp/mlx-cutover.sh:52-58` (15s poll). Same pattern applies.
Additional risk for vcontext: node server's `--max-old-space-size=4096`
+ 4.14 GB primary.sqlite can extend graceful-exit time beyond
MLX-embed's. If node honors SIGTERM cleanly (vcontext-server has
its own signal handlers — not verified in this audit) unload
completes in seconds; if not, `wait_port_free`'s `kill -9` is the
fallback.

**Severity: LOW-MEDIUM.** Cutover script must mirror
`/tmp/mlx-cutover.sh:52-58` port-wait + optional stray-pkill.

## R4 — downstream dependencies (who breaks during outage)

### R4.1 MLX embed → vcontext
`mlx-embed-server-standalone.py:760` comment:
`# ── Ollama-compat (used by vcontext-server.js checkCoreml + /embed calls) ──`.
That's **vcontext calling mlx-embed**, not the reverse. Greps for
`3150` / `VCONTEXT_URL` / `vcontext` in the python file return
**only** that one line. **MLX embed does not call vcontext.**

### R4.2 hooks → vcontext
`vcontext-hooks.js:18` = `VCONTEXT_PORT || '3150'`.
`:73 timeout: 3000` for per-hook posts (UserPromptSubmit etc.).
`:84-85`: `req.on('error', ...) { enqueueForLater }` and
`req.on('timeout', ...) { enqueueForLater }`. Failed posts write
to `/tmp/vcontext-queue.jsonl` and drain on next successful call
(`:152-203`, `drain-queue` command). Wrapper `:138-147` runs
`drain-queue` automatically after server health returns.

**So during cutover: hooks queue, then drain on recovery.** No
data loss, brief latency spike. Matches today's kickstart-k
behavior — no new regression.

### R4.3 admin calls
`:97 postAdmin(... timeoutMs = 30000)`, `:127 getAdmin(... 5000)`.
These **do not enqueue on failure** (`:94-95` comment:
`These DO NOT enqueue on failure — admin calls are idempotent reads`).
Loss = a missed one-shot admin call, not persistent data.

**Severity: LOW.** No data loss path introduced by cutover.

## R5 — 116-restart-loop history (2026-04-20)

Plist comments `:19-49`: the cascade was blamed on launchd
classifying the service as "inefficient" under a rapid respawn
cycle, then `ProcessType=Interactive` + `ThrottleInterval=15` were
added to dampen it. **Both fields are dropped under the `.app`
pattern** per `com.vcontext.mlx-embed.plist:28-39`:
```
Fields dropped ... ProcessType: applies only to /usr/bin/open.
```

Concretely under `.app`:
- Plist `ProcessType=Interactive` → would apply to
  `/usr/bin/open`, not the node process. Lost.
- Plist `Nice=-5` → same, lost.
- Plist `ThrottleInterval=15` → still effective (governs launchd
  respawn of `/usr/bin/open`, independent of the child).

Mitigation: cat=app already raises jetsam priority 40→100 (the
primary fix), which is a stronger protection than
`ProcessType=Interactive`. Loss of `Nice=-5` is accepted per
yesterday's audit.

**The restart loop risk specifically**: if node itself crash-loops
inside bash, bash's `:120-132` backoff + `exit 3` after 5 failures
is unchanged. launchd then sees exit, waits `ThrottleInterval=15`,
respawns `open`. **No new loop pathway introduced.**

**Severity: LOW.** Throttle remains; pri=100 should reduce kill
rate (see `docs/analysis/2026-04-23-vcontext-sigkill-137-investigation.md:127-144`).

## R6 — rollback path equivalence

MLX-cutover failure modes and vcontext equivalents:

| `/tmp/mlx-cutover.sh` check | vcontext equivalent | Feasible? |
|---|---|---|
| `:128` `/health "status":"healthy"` | `GET /health` on 3150 | YES — vcontext-wrapper.sh:141 already uses it |
| `:156-157` label `application.com.vcontext.mlx-embed.*` | `application.com.vcontext.server.*` | YES |
| `:164-165` cat=app, pri=100 via `launchctl print` | Identical | YES |
| `:178-182` smoke test `/api/embeddings` dim=4096 | `/store` + `/recall` round-trip OR simple `/health` JSON shape | YES, use `/store` echo or `/recall?q=test` |
| backup plist `.bak-<timestamp>` | Same | YES |

**vcontext-specific additional failure modes (not in MLX flow):**
1. **Queued writes from hooks pile up during long outage.** If
   `/tmp/vcontext-queue.jsonl` grows large before drain, the
   post-startup drain (`vcontext-wrapper.sh:138-147`) runs in
   background but can delay observed consistency. Add check:
   after health-OK, confirm queue file size < threshold (e.g. 1 MB)
   before declaring success.
2. **sqlite DB lock inheritance.** Old node had an open fd to
   `vcontext-primary.sqlite` (4.14 GB). If killed mid-write and
   new node starts before fd is released, new node may hit
   `SQLITE_BUSY`. Not observed in today's plist (same code path),
   but under `.app` the stop timing is looser — longer gap between
   old-kill and new-spawn helps here rather than hurts.
3. **Worker thread / watchdog** (`vcontext-server.js:304-334`
   per sigkill-137 doc) — on stop, node must exit cleanly so the
   worker terminates. If bash `wait` races the node's own SIGKILL
   watchdog, harmless (same PID, same exit).

**Severity: LOW.** Rollback path maps 1:1 with one additional
post-ready check (queue file size).

## GO/HOLD verdict

**GO with 3 mandatory additions to the cutover script:**

1. **Mirror `/tmp/mlx-cutover.sh:34-46` orphan-kill** for any
   `node.*vcontext-server\.js` that survives `launchctl unload`.
   Pattern: `pkill -f 'scripts/vcontext-server\.js'` + 15s port-wait.
2. **Patch `scripts/vcontext-reload.sh`** to sweep stray node
   after `kickstart -k`, because `.app` orphaning means the existing
   one-liner is incomplete.
3. **Post-ready queue-size check** (< 1 MB in
   `/tmp/vcontext-queue.jsonl`) before declaring cutover success;
   otherwise wait for wrapper auto-drain (up to 30s).

No **BLOCKERS** identified. All regressions (R1.1 orphan-on-stop,
R1.2 reload-without-pkill, R5 `ProcessType`/`Nice` loss) have
existing handler code (wait_port_free, wrapper-lock takeover) or
match yesterday's accepted MLX trade-offs.

Word count: ~1,180.

SAVED: /Users/mitsuru_nakajima/skills/docs/analysis/2026-04-23-p0a-cat-app-audit.md
