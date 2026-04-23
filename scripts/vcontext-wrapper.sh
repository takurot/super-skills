#!/bin/bash
# Zero-downtime wrapper for vcontext-server
# Watches for SIGHUP to gracefully restart the server
# Usage: ./scripts/vcontext-wrapper.sh

NODE="/Users/mitsuru_nakajima/.nvm/versions/node/v25.9.0/bin/node"
SERVER="/Users/mitsuru_nakajima/skills/scripts/vcontext-server.js"
PID_FILE="/tmp/vcontext-server.pid"

# Fix C — single-instance guard. LaunchAgent KeepAlive=true plus any
# stray `launchctl kickstart` / `bootstrap` can spawn multiple wrappers
# that then fight for port 3150. macOS has no `flock(1)`, so we use a
# PID-file sentinel: if the recorded wrapper PID is still alive, exit.
# Stale PIDs (from SIGKILL / crash / reboot) are harmlessly taken over.
WRAPPER_LOCK="/tmp/vcontext-wrapper.lock"
if [[ -f "$WRAPPER_LOCK" ]]; then
  OTHER=$(cat "$WRAPPER_LOCK" 2>/dev/null)
  if [[ -n "$OTHER" ]] && kill -0 "$OTHER" 2>/dev/null; then
    echo "[wrapper] Another wrapper (PID $OTHER) is active — exiting cleanly."
    exit 0
  fi
  echo "[wrapper] Stale lock from PID $OTHER — taking over."
fi
echo $$ > "$WRAPPER_LOCK"

# Load runtime env overrides (VCONTEXT_BIND=0.0.0.0 for LAN,
# VCONTEXT_MAX_HEAP_MB=2048 for heap cap, etc.).
# MUST come BEFORE the NODE_OPTIONS export below so VCONTEXT_MAX_HEAP_MB
# resolves at the ${VCONTEXT_MAX_HEAP_MB:-4096} interpolation. Prior
# ordering (env-source below NODE_OPTIONS) made VCONTEXT_MAX_HEAP_MB a
# silent no-op — latent bug discovered and fixed 2026-04-23 as part of
# P0b-heap rollout. See docs/analysis/2026-04-23-p0b-rss-reduction-audit.md.
ENV_FILE="$HOME/skills/data/vcontext.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Node 25 default heap ~2 GB. 2026-04-23 P0b-heap: capped at 2 GB via
# VCONTEXT_MAX_HEAP_MB=2048 in vcontext.env (peak observed 820 MB,
# 2 GB = 2.5x headroom, frees 2 GB RSS budget to system). Fallback
# default 4096 retained for the no-env-file case.
export NODE_OPTIONS="--max-old-space-size=${VCONTEXT_MAX_HEAP_MB:-4096} ${NODE_OPTIONS:-}"

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  rm -f "$WRAPPER_LOCK"
  exit 0
}

reload() {
  echo "[wrapper] Reloading server..."
  # Start new server first (it will fail to bind if old is still up, so we kill old first)
  # But we use SO_REUSEPORT concept: kill old, immediately start new
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    # Wait briefly for port to free
    sleep 1
  fi
  start_server
  echo "[wrapper] Server reloaded (PID: $SERVER_PID)"
}

wait_port_free() {
  # Wait up to 10s for port 3150 to be released by any prior process
  # before launching a new server. Without this, a watchdog-triggered
  # restart races against the dying server's TIME_WAIT and dies with
  # EADDRINUSE (66 such errors observed in the wild).
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -iTCP:3150 -sTCP:LISTEN -P -t >/dev/null 2>&1 || return 0
    # If something IS holding it, kill any stray non-wrapper process
    STRAY=$(lsof -iTCP:3150 -sTCP:LISTEN -P -t 2>/dev/null | head -1)
    if [[ -n "$STRAY" ]] && [[ "$STRAY" != "$SERVER_PID" ]]; then
      kill -9 "$STRAY" 2>/dev/null
    fi
    sleep 1
  done
}

wait_server_bound() {
  # Fix B — after spawning a server, wait up to 120s for it to actually
  # bind port 3150. Catches the "alive but hung" case (state=U, stuck
  # in .recover, blocked on a startup query, etc.) that `wait $PID`
  # never detects. Bumped from 45s → 120s on 2026-04-18 after the RAM
  # DB grew past ~47k entries and legitimate startup (SSD restore +
  # backfill + sqlite-vec load + MLX probes) started crossing 45s,
  # triggering false-positive zombie kills in a loop.
  local pid="$1"
  for i in $(seq 1 120); do
    # Process must still be alive
    kill -0 "$pid" 2>/dev/null || { echo "[wrapper] server PID $pid exited during startup"; return 1; }
    # And must own port 3150
    if lsof -iTCP:3150 -sTCP:LISTEN -P -t 2>/dev/null | grep -q "^${pid}$"; then
      echo "[wrapper] server PID $pid bound port 3150 (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "[wrapper] server PID $pid did not bind port 3150 within 45s — killing zombie."
  kill -9 "$pid" 2>/dev/null
  return 1
}

start_server() {
  wait_port_free
  $NODE "$SERVER" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  if ! wait_server_bound "$SERVER_PID"; then
    SERVER_PID=""
    return 1
  fi
}

trap cleanup SIGTERM SIGINT EXIT
trap reload SIGHUP

echo "[wrapper] Starting vcontext server..."
START_ATTEMPTS=0
while ! start_server; do
  START_ATTEMPTS=$((START_ATTEMPTS+1))
  # Exponential backoff, capped at 60s, and abort after 5 attempts so
  # launchd can see the failure and throttle (prevents CPU-eating
  # restart loops when the server exits fast with a config error).
  BACKOFF=$(( START_ATTEMPTS < 5 ? (2 ** START_ATTEMPTS) : 60 ))
  echo "[wrapper] Startup attempt $START_ATTEMPTS failed — backing off ${BACKOFF}s"
  if [[ $START_ATTEMPTS -ge 5 ]]; then
    echo "[wrapper] 5 consecutive failed startups — exiting so launchd can throttle."
    exit 3
  fi
  sleep "$BACKOFF"
done
echo "[wrapper] Server running (PID: $SERVER_PID)"

# After startup: wait for health, then drain any queued writes that
# accumulated while the server was down. Runs in background so startup
# is not blocked.
(
  HOOK_JS="$HOME/skills/scripts/vcontext-hooks.js"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s --max-time 1 http://127.0.0.1:3150/health >/dev/null 2>&1 && break
    sleep 1
  done
  if [ -f /tmp/vcontext-queue.jsonl ] && [ -f "$HOOK_JS" ]; then
    "$NODE" "$HOOK_JS" drain-queue >> /tmp/vcontext-startup-drain.log 2>&1
  fi
) &

# Wait forever, restarting if server dies.
# Exit-2 is reserved for ABI self-test failure — abort so launchd throttles
# instead of restarting in a tight loop (stale binary would just fail again).
while true; do
  if [[ -z "$SERVER_PID" ]]; then
    echo "[wrapper] SERVER_PID empty — attempting restart"
    sleep 2
    start_server || continue
  fi
  wait "$SERVER_PID" 2>/dev/null
  EXIT_CODE=$?
  SERVER_PID=""
  if [[ $EXIT_CODE -eq 2 ]]; then
    echo "[wrapper] Server exited with code 2 (ABI self-test failed) — exiting so launchd throttles."
    exit 2
  elif [[ $EXIT_CODE -ne 0 ]]; then
    echo "[wrapper] Server exited with code $EXIT_CODE, restarting in 2s..."
    sleep 2
    start_server || continue
    echo "[wrapper] Server restarted (PID: $SERVER_PID)"
  else
    echo "[wrapper] Server exited cleanly"
    break
  fi
done
