#!/bin/bash
# P0a vcontext-server cat=app cutover — production plist → .app-wrapped version.
# Mirrors /tmp/mlx-cutover.sh pattern + 3 mandatory additions per audit
# 2026-04-23-p0a-cat-app-audit.md GO/HOLD verdict (section after R6):
#
#   M1: pkill -f 'scripts/vcontext-server\.js' orphan sweep after kickstart
#       (R1.1 orphan-on-stop: node child becomes PPID=1 under .app, so
#        launchctl unload alone leaves it running on port 3150)
#
#   M2: 15s port-wait loop (30 iterations x 0.5s) for port 3150
#       (R3 port bind race: wait for old listener to release before new
#        wrapper attempts bind)
#
#   M3: Post-ready queue-size check — GET /health + /tmp/vcontext-queue.jsonl
#       size < 1 MB threshold, else wait for wrapper's own drain loop
#       (R4.2/R6 vcontext-specific: hook queue can spike during outage;
#        aborts if cold-start spike exceeds threshold)
#
# Pre-flight: backup plist must already exist (created by preparation step);
# production /health must be green before start (refuse to cut over a
# already-broken server).
#
# Auto-rollback: any failure within 60s of load → restore backup + kickstart.
# Idempotent: safe to re-run; re-invocation no-ops if .new == active plist.
#
# HARD STOP: this script must NOT be executed by preparation agents.

set -euo pipefail

PROD_PLIST=$HOME/Library/LaunchAgents/com.vcontext.server.plist
NEW_PLIST=$HOME/Library/LaunchAgents/com.vcontext.server.plist.new
NEW_APP=/Users/mitsuru_nakajima/skills/apps/VContextServer.app
HEALTH_URL=http://127.0.0.1:3150/health
QUEUE_FILE=/tmp/vcontext-queue.jsonl
QUEUE_MAX_BYTES=1048576   # 1 MB threshold per audit R6 addition
LABEL=com.vcontext.server
DOMAIN=gui/$(id -u)

log() { echo "[p0a-cutover $(date +%H:%M:%S)] $*"; }

# ── 0. Pre-flight ─────────────────────────────────────────────
log "Step 0/10 — pre-flight"

# Locate most-recent backup (created by preparation step)
BACKUP_PLIST=$(ls -t "$HOME/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-"* 2>/dev/null | head -1)
if [ -z "$BACKUP_PLIST" ] || [ ! -f "$BACKUP_PLIST" ]; then
  log "FATAL: no pre-p0a backup plist found — refusing to cut over"
  log "  expected: ~/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-YYYYMMDD-HHMMSS"
  exit 20
fi
log "backup: $BACKUP_PLIST"

# Check .new exists and lints
if [ ! -f "$NEW_PLIST" ]; then
  log "FATAL: $NEW_PLIST missing — run preparation step first"
  exit 21
fi
plutil -lint "$NEW_PLIST" > /dev/null

# Idempotency — if active plist already matches .new, nothing to do
if cmp -s "$PROD_PLIST" "$NEW_PLIST"; then
  log "active plist already matches .new — nothing to do (idempotent no-op)"
  exit 0
fi

# Production health probe (refuse to cut over a broken server)
PROD_HEALTH=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || true)
if ! echo "$PROD_HEALTH" | grep -q '"status":"healthy"'; then
  log "WARNING: production $HEALTH_URL not currently healthy: $PROD_HEALTH"
  log "proceeding anyway (cutover may itself restore health); auto-rollback guards"
fi
PROD_PID=$(pgrep -f "scripts/vcontext-server\.js" | head -1 || true)
log "production PID=$PROD_PID health=$(echo "$PROD_HEALTH" | head -c 80)"

# ── Shared rollback helper ────────────────────────────────────
autorollback() {
  local reason=$1
  log "AUTO-ROLLBACK triggered: $reason"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # M1: sweep any orphan node from failed new boot
  for P in $(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null); do
    kill -KILL $P 2>/dev/null || true
    log "  killed orphan node PID=$P"
  done
  sleep 2
  cp "$BACKUP_PLIST" "$PROD_PLIST"
  launchctl bootstrap "$DOMAIN" "$PROD_PLIST"
  log "  restored original plist from $BACKUP_PLIST"
  log "  waiting for production /health ..."
  for i in $(seq 1 30); do
    sleep 2
    if curl -sS -m 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"healthy"'; then
      log "  ROLLBACK COMPLETE (production restored)"
      return 0
    fi
  done
  log "  WARNING: production did not come back healthy within 60s — manual intervention required"
  return 1
}

LOAD_T=$(date +%s)

# ── 1. Move .new over original plist ──────────────────────────
log "Step 1/10 — move .new over original"
mv "$NEW_PLIST" "$PROD_PLIST"
plutil -lint "$PROD_PLIST" > /dev/null

# ── 2. launchctl bootout (old) ────────────────────────────────
log "Step 2/10 — bootout old service"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
UNLOAD_T=$(date +%s)

# ── 3. M1: orphan-node pkill (MANDATORY ADDITION #1) ──────────
log "Step 3/10 — M1 orphan node sweep (MANDATORY per audit R1.1/R1.2)"
for P in $(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null); do
  kill -TERM $P 2>/dev/null || true
  log "  killed orphan node PID=$P (TERM)"
done
sleep 1
for P in $(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null); do
  kill -KILL $P 2>/dev/null || true
  log "  killed orphan node PID=$P (KILL)"
done

# ── 4. M2: 15s port-wait loop (MANDATORY ADDITION #2) ─────────
log "Step 4/10 — M2 port 3150 free wait (MANDATORY per audit R3)"
PORT_FREE=0
for i in $(seq 1 30); do
  if ! lsof -iTCP:3150 -sTCP:LISTEN -P -t >/dev/null 2>&1; then
    PORT_FREE=1
    FREE_T=$(date +%s)
    log "  port 3150 free after $((FREE_T - UNLOAD_T))s (iter=$i)"
    break
  fi
  sleep 0.5
done
if [ "$PORT_FREE" != "1" ]; then
  autorollback "port 3150 still bound after 15s"
  exit 30
fi

# ── 5. launchctl bootstrap (new) ──────────────────────────────
log "Step 5/10 — bootstrap new service"
launchctl bootstrap "$DOMAIN" "$PROD_PLIST"

# ── 6. Post-bootstrap orphan check ────────────────────────────
# Extra safety: if launchd created a new process but somehow left an
# old node alive, sweep again.
log "Step 6/10 — post-bootstrap stray sweep"
sleep 1
STRAY_COUNT=$(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null | wc -l | tr -d ' ')
if [ "$STRAY_COUNT" -gt "1" ]; then
  log "  WARNING: $STRAY_COUNT node processes — investigating"
fi

# ── 7. Wait for /health ready ─────────────────────────────────
log "Step 7/10 — wait for /health ready"
READY_T=""
for i in $(seq 1 45); do
  sleep 2
  R=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$R" | grep -q '"status":"healthy"'; then
    READY_T=$(date +%s)
    log "  READY after $((READY_T - LOAD_T))s (iter=$i)"
    break
  fi
done
if [ -z "$READY_T" ]; then
  autorollback "new /health never went healthy in 90s"
  exit 10
fi

# ── 8. M3: post-ready queue-size check (MANDATORY ADDITION #3) ─
log "Step 8/10 — M3 queue-size check (MANDATORY per audit R6)"
if [ -f "$QUEUE_FILE" ]; then
  QSIZE=$(stat -f%z "$QUEUE_FILE" 2>/dev/null || echo 0)
  log "  queue file size: $QSIZE bytes (threshold $QUEUE_MAX_BYTES)"
  if [ "$QSIZE" -gt "$QUEUE_MAX_BYTES" ]; then
    log "  queue > 1 MB — waiting up to 30s for wrapper auto-drain"
    for i in $(seq 1 15); do
      sleep 2
      QSIZE=$(stat -f%z "$QUEUE_FILE" 2>/dev/null || echo 0)
      if [ "$QSIZE" -le "$QUEUE_MAX_BYTES" ]; then
        log "  queue drained to $QSIZE bytes after $((i*2))s"
        break
      fi
    done
    # Re-check — if still huge after drain window, treat as cold-start spike abort
    if [ "$QSIZE" -gt "$QUEUE_MAX_BYTES" ]; then
      autorollback "queue-size cold-start spike: $QSIZE bytes > 1MB after 30s wrapper drain"
      exit 40
    fi
  fi
else
  log "  no queue file — fresh start, OK"
fi

# Confirm health is still green after queue check (cold-start spike guard)
R=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || true)
if ! echo "$R" | grep -q '"status":"healthy"'; then
  autorollback "health regressed after queue-drain wait: $R"
  exit 41
fi

# ── 9. Verify jetsam category=app, priority=100 ──────────────
log "Step 9/10 — jetsam verification"
sleep 2
APP_LABEL=$(launchctl list | awk '$3 ~ /^application\.com\.vcontext\.server\./ {print $3}' | head -1)
if [ -z "$APP_LABEL" ]; then
  autorollback "no application.com.vcontext.server.* label — cat=app not achieved"
  exit 2
fi
log "  label: $APP_LABEL"
INFO=$(launchctl print "$DOMAIN/$APP_LABEL" 2>&1)
CAT=$(echo "$INFO" | awk -F= '/jetsamproperties category/ {gsub(/^[ \t]+/,"",$2); print $2}' | head -1)
PRI=$(echo "$INFO" | awk -F= '/jetsam priority/ {gsub(/^[ \t]+/,"",$2); print $2}' | head -1)
log "  category=$CAT priority=$PRI"
if [ "$CAT" != "app " ] && [ "$CAT" != "app" ]; then
  autorollback "category='$CAT' expected 'app'"
  exit 3
fi
if [ "$PRI" != "100" ]; then
  autorollback "priority='$PRI' expected '100'"
  exit 4
fi

# ── 10. Smoke test /recall ─────────────────────────────────────
log "Step 10/10 — smoke test /recall"
R=$(curl -sS -m 10 "http://127.0.0.1:3150/recall?q=p0a-cutover-smoke&limit=1" 2>&1 || true)
if ! echo "$R" | python3 -c "import json,sys;json.load(sys.stdin)" >/dev/null 2>&1; then
  autorollback "smoke /recall did not return JSON: $R"
  exit 5
fi
log "  /recall JSON OK"

TOTAL_T=$(date +%s)
log "P0a CUTOVER COMPLETE — total elapsed $((TOTAL_T - LOAD_T))s"
log ""
log "MANUAL ROLLBACK (if anything goes wrong later):"
log "  /Users/mitsuru_nakajima/skills/scripts/p0a-rollback.sh"
