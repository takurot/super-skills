#!/bin/bash
# P0a vcontext-server rollback — restore pre-P0a plist backup.
#
# Use when:
#   - p0a-cutover.sh auto-rollback itself failed
#   - Post-cutover instability appears hours/days later
#   - Manual revert needed for any reason
#
# What it does:
#   1. Find most-recent ~/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-*
#   2. bootout current service
#   3. Sweep orphan node (same M1 pattern as cutover)
#   4. Restore backup over active plist
#   5. bootstrap
#   6. Verify /health returns
#
# HARD STOP: this script must NOT be executed by preparation agents.

set -euo pipefail

PROD_PLIST=$HOME/Library/LaunchAgents/com.vcontext.server.plist
HEALTH_URL=http://127.0.0.1:3150/health
LABEL=com.vcontext.server
DOMAIN=gui/$(id -u)

log() { echo "[p0a-rollback $(date +%H:%M:%S)] $*"; }

# ── 1. Locate backup ──────────────────────────────────────────
BACKUP_PLIST=$(ls -t "$HOME/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-"* 2>/dev/null | head -1)
if [ -z "$BACKUP_PLIST" ] || [ ! -f "$BACKUP_PLIST" ]; then
  log "FATAL: no pre-p0a backup plist found — cannot roll back"
  log "  expected pattern: ~/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-YYYYMMDD-HHMMSS"
  exit 20
fi
log "rollback source: $BACKUP_PLIST"

# Refuse no-op — if active plist is already identical to backup, nothing to do
if cmp -s "$PROD_PLIST" "$BACKUP_PLIST"; then
  log "active plist already matches backup — nothing to do"
  exit 0
fi

# ── 2. bootout current service ────────────────────────────────
log "Step 1/5 — bootout current service"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
UNLOAD_T=$(date +%s)

# ── 3. Sweep orphan node ──────────────────────────────────────
log "Step 2/5 — orphan node sweep"
for P in $(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null); do
  kill -TERM $P 2>/dev/null || true
  log "  killed orphan node PID=$P (TERM)"
done
sleep 1
for P in $(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null); do
  kill -KILL $P 2>/dev/null || true
  log "  killed orphan node PID=$P (KILL)"
done

# Wait for port free before bootstrap
for i in $(seq 1 30); do
  if ! lsof -iTCP:3150 -sTCP:LISTEN -P -t >/dev/null 2>&1; then
    log "  port 3150 free after $(( $(date +%s) - UNLOAD_T ))s"
    break
  fi
  sleep 0.5
done

# ── 4. Restore backup ─────────────────────────────────────────
log "Step 3/5 — restore backup over active plist"
cp "$BACKUP_PLIST" "$PROD_PLIST"
plutil -lint "$PROD_PLIST" > /dev/null

# ── 5. bootstrap ──────────────────────────────────────────────
log "Step 4/5 — bootstrap"
launchctl bootstrap "$DOMAIN" "$PROD_PLIST"

# ── 6. Verify /health ──────────────────────────────────────────
log "Step 5/5 — wait for /health"
for i in $(seq 1 45); do
  sleep 2
  R=$(curl -sS -m 3 "$HEALTH_URL" 2>/dev/null || true)
  if echo "$R" | grep -q '"status":"healthy"'; then
    log "  ROLLBACK COMPLETE — /health healthy after ${i} iters"
    exit 0
  fi
done

log "WARNING: /health did not go healthy within 90s — manual intervention required"
exit 10
