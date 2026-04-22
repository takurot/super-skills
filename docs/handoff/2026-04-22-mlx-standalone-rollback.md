# MLX Embed Standalone — Rollback & Switching Guide

*Created 2026-04-22 evening, session 28d38f34. Companion to the
`mlx-embed-server-standalone.py` refactor that removes the `mlx_lm` /
`transformers` / `sympy` dependency chain so the server can be wrapped
in a macOS .app bundle for jetsam `category=app` (priority 100)
protection vs the LaunchAgent default `category=daemon` (priority 40).*

## What changed

| Path | Status | Note |
|------|--------|------|
| `scripts/mlx-embed-server.py` | **UNTOUCHED** | Original production server. Always available for instant rollback. |
| `scripts/mlx-embed-server-standalone.py` | **NEW** | mlx_lm-free variant. Route-compatible, bit-exact to production. |
| `apps/MLXEmbedServerStandalone.app/` | **NEW** | Minimal .app bundle: Info.plist + bash wrapper that execs the Python script. Achieves cat=app without Nuitka/py2app compilation. |
| `~/Library/LaunchAgents/com.vcontext.mlx-embed.plist` | **UNCHANGED (yet)** | Still runs `python3 mlx-embed-server.py` directly. Promotion flow below replaces with `open -W -n -a MLXEmbedServerStandalone.app`. |

### Why bash-wrapper .app instead of Nuitka/py2app

Empirically verified 2026-04-22:
- `LaunchAgent → python3 direct` → `spawn_type=interactive(4), cat=daemon, pri=40`
- `LaunchAgent → /usr/bin/open -W -n -a <bash-script-.app>` → `spawn_type=app(1), cat=app, pri=100`

The `.app` just needs Info.plist + an executable in `Contents/MacOS/`. That executable can be a **bash script**; it does not need to be a Mach-O binary. Launch Services registers the app and runningboardd spawns the child with `cat=app`, independent of the wrapped executable type. Nuitka compilation was attempted but is **unnecessary** for the jetsam goal.

## Equivalence verified

| Test | Result |
|------|--------|
| POC (standalone vs `mlx_lm.load`), same Python process | max\|diff\|=0, cos=1.0000000000 (3/3) |
| HTTP /api/embeddings single-shot, 3161 vs 3162 | cos ≥ 0.9999998808 (5/5) |
| HTTP /embed_batch fresh (cache-miss via nonce), 3161 vs 3162 | cos ≥ 0.9999999404 (5/5) |
| HTTP /embed_batch second pass (cache-hit) | cos ≥ 0.9999999404 (5/5) |

Tokenizer output verified IDENTICAL (Rust direct vs HF wrapper).
Residual ~1e-7 cosine deltas are fp32 round-trip through JSON / numpy
`tolist()`, not algorithmic.

Note: an existing production bug surfaced during this work — the
`_embedding_cache` keys on `(text, normalize)` only, so a single-shot
(no padding) result can be cached then returned for a later batch
request where the same text would have been padded differently. Both
servers have the identical cache logic so both exhibit the same
behaviour; standalone does not introduce the bug, but the bug is now
documented for a future fix (defer).

## Promote standalone → production (via .app wrapper)

Use `/tmp/mlx-cutover.sh` — 164-line automated script that does all 8 steps.
Or do manually:

```bash
PROD_PLIST=~/Library/LaunchAgents/com.vcontext.mlx-embed.plist
BACKUP=${PROD_PLIST}.bak-$(date +%Y%m%d-%H%M%S)
NEW_APP=/Users/mitsuru_nakajima/skills/apps/MLXEmbedServerStandalone.app
TEST_PLIST=~/Library/LaunchAgents/com.vcontext.mlx-embed-standalone-test.plist

# 1. Backup + stop test .app (free port 3162 + orphan python)
cp "$PROD_PLIST" "$BACKUP"
launchctl unload "$TEST_PLIST" 2>/dev/null
pgrep -f mlx-embed-server-standalone.py | xargs -r kill -TERM

# 2. Stop production
launchctl unload "$PROD_PLIST"

# 3. Write new plist (simplified — drops Nice/ProcessType/Env since they
#    apply only to /usr/bin/open, not the .app child per runningboardd)
cat > "$PROD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vcontext.mlx-embed</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-W</string><string>-n</string><string>-a</string>
    <string>$NEW_APP</string>
    <string>--args</string>
    <string>--model</string><string>8B</string>
    <string>--port</string><string>3161</string>
    <string>--host</string><string>127.0.0.1</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
EOF

# 4. Load + verify
launchctl load "$PROD_PLIST"
sleep 15
curl -sS http://127.0.0.1:3161/api/health | python3 -m json.tool
# expect "backend":"mlx-standalone"

APP_LABEL=$(launchctl list | awk '$3 ~ /^application.com.vcontext.mlx-embed./{print $3}' | head -1)
launchctl print gui/$(id -u)/"$APP_LABEL" | grep -iE "jetsam|spawn"
# expect: spawn type = app (1)   jetsam priority = 100   category = app
```

### Fields dropped from the plist (and why)

Verified via `man launchd.plist` + empirical observation 2026-04-22:

| Old key | Why dropped when Program=`/usr/bin/open` |
|---|---|
| `StandardOutPath/Err` | `open -W` does NOT forward child stdout; the wrapper bash script redirects to `/tmp/mlx-embed-server-standalone.log` itself. |
| `Nice=-20` | Applies to `/usr/bin/open` only. runningboardd spawns the .app child fresh and does not inherit. Non-root cannot set nice<0 from bash either. |
| `ProcessType=Interactive` | Applies to `/usr/bin/open`. |
| `LowPriorityIO=false` | Applies to `/usr/bin/open`. |
| `EnvironmentVariables` | Does not propagate through `open` to the .app; runningboardd uses its own env. |
| `WorkingDirectory` | Wrapper script does `cd /Users/mitsuru_nakajima/skills` internally. |

Kept: `Label`, `ProgramArguments` (the new `open` chain), `RunAtLoad`,
`KeepAlive{SuccessfulExit=false}`, `ThrottleInterval=10`.

## Rollback → original production (daemon-category, pre-cutover)

```bash
PROD_PLIST=~/Library/LaunchAgents/com.vcontext.mlx-embed.plist
# Find the most recent backup (created by cutover)
BACKUP=$(ls -t ${PROD_PLIST}.bak-* 2>/dev/null | head -1)
echo "Using backup: $BACKUP"

launchctl unload "$PROD_PLIST"
# Kill orphan python from the .app pattern (PPID=1 by design)
pgrep -f mlx-embed-server-standalone.py | xargs -r kill -TERM

cp "$BACKUP" "$PROD_PLIST"
launchctl load "$PROD_PLIST"
sleep 15
curl -sS http://127.0.0.1:3161/api/health   # expect "backend":"mlx"
```

If no `.bak-*` exists, the original production plist is reconstructible
from git history (`git show HEAD:Library/LaunchAgents/com.vcontext.mlx-embed.plist`
once committed, or from the content at the top of this doc's history).

## Complete removal of the standalone work

If the refactor needs to be wiped entirely:

```bash
# 1. Ensure plist points at the original (see Rollback above).
# 2. Remove the new file.
rm /Users/mitsuru_nakajima/skills/scripts/mlx-embed-server-standalone.py

# 3. Revert this doc (or keep it as a lesson record).
rm /Users/mitsuru_nakajima/skills/docs/handoff/2026-04-22-mlx-standalone-rollback.md
```

Original `scripts/mlx-embed-server.py` remains the source of truth.
No commits have been made on top of it during this refactor.

## Dependencies expected by the new file

Python 3.13 (`~/.pyenv/versions/3.13.2/bin/python3` on this host). All
of these are already installed on the production Python:

| Import | Purpose |
|--------|---------|
| `mlx.core`, `mlx.nn`, `mlx.utils` | Already used by production |
| `tokenizers` | 0.22.2 confirmed; Rust binding, no transformers dep |
| `fastapi`, `uvicorn`, `pydantic` | Already used by production |
| `numpy` | Already used by production |
| `huggingface_hub` | Used only on cache miss (auto-download fallback). Verified no heavy deps (no transformers/sympy/scipy/torch; 481 mostly-stdlib modules). |

**NOT required (the whole point)**: `mlx_lm`, `transformers`, `sympy`,
`scipy`, `torch`, `jinja2`, `protobuf`, `pyyaml`, `sentencepiece`.

## Independent QA (2026-04-22 evening)

Second-opinion check by Explore agent + main's re-verification found one
regression and one pre-existing bug:

1. **Regression (FIXED)**: `resolve_model_dir()` originally raised
   `FileNotFoundError` on cache miss, unlike `mlx_lm.load()` which
   auto-downloads. Fixed by adding a `huggingface_hub.snapshot_download`
   fallback (see new file lines for `resolve_model_dir`). Regression
   test verified: cached model still resolves without hitting the
   download path.

2. **Pre-existing bug (NOT A REGRESSION, spawned as separate task)**:
   `_embedding_cache` key `f"{model}:{text}:{normalize}"` ignores batch
   shape. Same text served single-shot then via batch (with a longer
   sibling that forces padding) yields `cos=0.55` mismatch. Both the
   original and the standalone variant exhibit this bug identically —
   standalone does not introduce it. Tracked in spawned task.

Route/schema coverage verified full-count: original 10 paths and
standalone 10 paths match 10/10 (initial awk extraction missed
multi-line decorators, re-verified with line-aware grep). 7 Pydantic
schemas match field-level 7/7. Tokenizer edge cases 9/9 matched in
main's earlier single-batch test (batch IDs + attention_mask bit-identical
between Rust direct and HF wrapper).

## Downstream consumers verified compatible

- `vcontext-server.js` talks to MLX via `/api/embeddings`, `/embed_batch`,
  and `/api/health` — all three are implemented with identical
  request/response shapes in the standalone variant.
- The `/api/health` response includes `"backend": "mlx-standalone"`
  instead of `"mlx"` — this is cosmetic and does not affect routing.
- Port 3161 keep-alive probe (every 10s, same "ping" text) works
  because `/api/embeddings` accepts the same Ollama-compat payload.

## Next steps (not done yet)

1. Promote standalone to production per "Promote" section above.
2. Nuitka-bundle the standalone script into a macOS .app so macOS
   Launch Services classifies the process as `category=app`, giving
   it jetsam priority above the user-LaunchAgent cap of 40.
3. Switch the plist to `open -W -n -a <the new .app>` (or register
   the bundle via Launch Services).
4. Measure jetsam priority (Activity Monitor → CPU → "Kind" column,
   or `sysctl kern.memorystatus_vm_pressure_level`).
