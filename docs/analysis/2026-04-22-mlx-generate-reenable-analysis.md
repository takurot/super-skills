# MLX-Generate Re-Enable Analysis (2026-04-22)

READ-ONLY analysis. Question: can today's mlx-embed `cat=app/pri=100`
cutover pattern make re-enabling `com.vcontext.mlx-generate` (Qwen3-8B-4bit
+ Qwen3-0.6B draft, port 3162) safe?

## 1. Memory budget (evidence-first)

Measured on system right now:

- RAM total: **36 GB**
- Swap: **14.3 GB configured, 12.9 GB used (~90% saturated, encrypted)**
- Active + wired pages: **~16 GB** (1,075,020 × 16KB)
- mlx-embed (port 3161) current RSS: **90 MB** — model weights swapped
  out (matches handoff §3: "RSS oscillates 250MB-3.4GB under pressure")
- Top competing processes (RSS): Chrome Renderer 1.1 GB, Antigravity
  0.9 GB, Claude Helper 0.9 GB, Codex 0.7 GB

Expected mlx-generate footprint when loaded:

| Component | Size |
|-----------|------|
| Qwen3-8B-4bit main weights | ~4.2 GB |
| Qwen3-0.6B-4bit draft weights | ~0.4 GB |
| mlx_lm.server Python overhead | ~0.5 GB |
| Prompt cache (`--prompt-cache-bytes 1073741824`) | up to 1.0 GB |
| **Peak total** | **~6.1 GB** |

Handoff doc's "+6 GB resident" is accurate. With both MLX servers
co-resident at peak: ~10.3 GB MLX + ~16 GB other = **26 GB
active/wired of 36 GB** — 10 GB headroom, but swap is already 90%
saturated. This is the heart of the risk.

## 2. Transfer analysis — what of today's pattern applies

Direct transfer (verified by reading both files):

- **`.app` bundle structure**: Info.plist + `Contents/MacOS/<exec>` bash
  wrapper. Directly copyable with renamed CFBundleIdentifier
  (`com.vcontext.mlx-generate-standalone`) and CFBundleName.
- **LaunchAgent plist shape**: `/usr/bin/open -W -n -a <app> --args ...`
  form. Drop Nice/ProcessType/LowPriorityIO (don't propagate through
  `open`, documented in existing mlx-embed plist comment).
- **Logging pattern**: bash wrapper self-redirects to `/tmp/...log` with
  10MB rotation. Copy as-is.
- **KeepAlive + ThrottleInterval=10**: same auto-restart story.

What needs adjustment:

- **Command line**: current wrapper execs `python3 -m mlx_lm.server
  --model ... --draft-model ... --port 3162`. .app wrapper must exec
  the same (not a standalone rewrite — see Q4 answer).
- **NO standalone rewrite needed**: mlx-embed was rewritten into
  `mlx-embed-server-standalone.py` as Nuitka prep (which proved
  unneeded). For mlx-generate the speculative-decoding `mlx_lm.server`
  is non-trivial to reimplement — just wrap the existing invocation.
  `mlx_lm` is installed at `~/.pyenv/versions/3.13.2/lib/python3.13/
  site-packages/mlx_lm` — available.

What doesn't transfer:

- **Nothing blocks** at the .app-bundle layer. Same mechanism works
  for any Python server.

## 3. Risk matrix

| # | Risk | Severity | Reason |
|---|------|----------|--------|
| 1 | **Swap cascade** — swap already 90% used; adding 6.1 GB peak tips system into page-thrash; other apps (Chrome/Claude) get jetsam-killed in cascade | **HIGH** | This is *the* handoff-doc blocker. cat=app uplift protects mlx-generate itself but doesn't free RAM; it just redirects jetsam pressure to competing user apps (Chrome=pri 100, Claude=pri 100 — same tier) |
| 2 | **Unified memory / GPU contention** — M-series shares GPU mem with system RAM; two MLX servers concurrently sharing Metal queues | MEDIUM | Both use `mx.metal` — likely serialized at Metal level, mutual slowdown not OOM; embed keep-alive (10s) + generate requests would queue |
| 3 | **Metal cache budget** — mlx-embed sets `set_cache_limit(5GB)`; mlx_lm.server has its own internal cache (no equivalent knob exposed in wrapper) | MEDIUM | Combined Metal cache could consume 8-10 GB — double-counts into swap |
| 4 | **Draft model + prompt cache pin** — `--prompt-cache-size 8 --prompt-cache-bytes 1GB` keeps hot pages resident; reduces jetsam swap-out but consumes steady state | LOW | Intentional; trades memory for latency |
| 5 | **Jetsam pri=100 != invincibility** — user-space ceiling is 100; Chrome/Claude also sit at 100. Under severe pressure macOS may still kill mlx-generate, just later than pri=40 | LOW | Net stability gain vs. status quo (disabled) is positive, but not "solved" |

## 4. Recommended path forward

**NEEDS-TEST-FIRST** — do not blind-enable.

Rationale: cat=app uplift resolves the *jetsam survival* angle (handoff
doc's stated blocker was "would worsen jetsam loop" — pri=100 largely
defuses that). But the *swap-pressure cascade* (Risk 1) is independent
of jetsam priority and is not addressed by today's pattern. Current
swap at 12.9/14.3 GB is a red flag. Re-enabling mlx-generate in this
state could push the box into thrash that harms Chrome/Claude/Codex
(all pri=100 siblings, so jetsam picks based on other heuristics).

The user's overnight-drain strategy (handoff §D2, vcontext id=234497)
already accepts daytime swap pressure for mlx-embed alone. Adding 6 GB
on top of that during the day is a qualitative shift.

## 5. Concrete steps (if user accepts NEEDS-TEST-FIRST)

Stage the rollout — do not combine steps:

1. **Prep bundle (no enable)**: copy
   `apps/MLXEmbedServerStandalone.app/` →
   `apps/MLXGenerateServerStandalone.app/`. Edit Info.plist
   (CFBundleName/Identifier/Executable) + rename MacOS binary. Replace
   wrapper's `SERVER_PY` with an inline `exec python3 -m mlx_lm.server
   --model ... --draft-model ... --port 3162 --host 127.0.0.1`. No LA
   change yet.
2. **Prep plist (disabled)**: rewrite
   `com.vcontext.mlx-generate.plist` to the `open -W -n -a` form.
   Keep `Disabled=true` or just don't `launchctl load` yet.
3. **Gate on swap**: before enabling, wait for swap used < 4 GB
   (overnight, apps closed). Command:
   `sysctl vm.swapusage | awk -F'[= ]+' '{print $5}'`.
4. **Single-run manual test**: `launchctl load ...plist`, wait 60s,
   verify `jetsam_priority=100` via `launchctl procinfo <pid>`,
   measure co-resident RSS via `ps -o rss`.
5. **Observe 10 min**: watch `/tmp/mlx-generate-server.log`,
   `sysctl vm.swapusage`, and `sqlite3 ...vcontext-primary.sqlite
   'SELECT COUNT(*) FROM entries WHERE type="anomaly-alert" AND
   created_at >= datetime("now","-10 minute");'`. If swap grows
   >2 GB in 10 min or anomaly count >0 → `launchctl unload`,
   abort.
6. **Revert path**: `launchctl unload` + disable plist. .app bundle
   can stay dormant on disk; no side effect.

Do not attempt during daytime app activity. The overnight-drain window
is the appropriate test slot (parallel to decision id=234497).

---

*Analysis by agent under investigate + careful per CLAUDE.md AIOS
protocol. Evidence collected: /Users/mitsuru_nakajima/Library/
LaunchAgents/com.vcontext.mlx-generate.plist, /Users/mitsuru_nakajima/
skills/scripts/mlx-generate-wrapper.sh, /Users/mitsuru_nakajima/skills/
apps/MLXEmbedServerStandalone.app/Contents/{Info.plist,MacOS/*}, live
`sysctl vm.swapusage` + `vm_stat` + `ps`.*
