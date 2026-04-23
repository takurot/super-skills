#!/bin/bash
# vcontext-observation-probe.sh
# Periodic probe that writes vcontext-server health state to vcontext itself.
# Runs every 15 min via com.vcontext.observation-probe LaunchAgent.
# Overnight signals (SIGKILL-137 re-emergence, M2 shadow FP spikes, swap creep)
# are captured regardless of user presence.
#
# Exits 0 always — launchd must not see failures. Falls back gracefully when
# vcontext is down (probably mid-restart).
#
# Created 2026-04-23 after P0a cutover (10 commits hardening vcontext-server).

set +e  # never let a single failing tool abort the probe
umask 022

LOG=/tmp/vcontext-server.log
VCONTEXT_URL="http://127.0.0.1:3150"
P0A_CUTOVER="2026-04-23T01:54:52"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- 1. Watchdog last emit (latest [watchdog] rss=... line) -----------------
WATCHDOG_LAST=""
if [ -r "$LOG" ]; then
  WATCHDOG_LAST=$(grep '\[watchdog\] rss=' "$LOG" 2>/dev/null | tail -1)
fi

# --- 2. SIGKILL-137 count since P0a cutover ---------------------------------
SIGKILL_137_COUNT=0
if [ -r "$LOG" ]; then
  # Only count lines that BEGIN with an ISO timestamp (leading 2026-...Z)
  # — the wrapper's own stdout (e.g. "[wrapper] Server exited with code
  # 137, restarting in 2s") has no timestamp prefix, so the naive awk
  # $1-compare accepts "[wrapper]" > "2026-..." lexicographically and
  # falsely inflates the count with wrapper restart lines. Anchor the
  # regex to the timestamp so wrapper-prefixed lines are excluded.
  SIGKILL_137_COUNT=$(grep -E '^2026-[0-9-]+T[0-9:.]+Z .*(SIGKILL|exit.*137|code.*137)' "$LOG" 2>/dev/null \
    | awk -v cutoff="$P0A_CUTOVER" '$1 > cutoff' \
    | wc -l | tr -d ' ')
fi

# --- 3. M2 evidence-gate-event count (recent 200) ---------------------------
EVIDENCE_GATE_COUNT=0
EVIDENCE_GATE_RESP=$(curl -sS -m 5 "${VCONTEXT_URL}/recent?type=evidence-gate-event&n=200" 2>/dev/null)
if [ -n "$EVIDENCE_GATE_RESP" ]; then
  EVIDENCE_GATE_COUNT=$(printf '%s' "$EVIDENCE_GATE_RESP" \
    | python3 -c 'import json,sys
try:
  print(len(json.load(sys.stdin).get("results",[])))
except Exception:
  print(0)' 2>/dev/null)
  [ -z "$EVIDENCE_GATE_COUNT" ] && EVIDENCE_GATE_COUNT=0
fi

# --- 4. swap usage (e.g. "used = 1024.00M") ---------------------------------
SWAP_USED=$(sysctl -n vm.swapusage 2>/dev/null | grep -oE 'used = [0-9.]+M' | head -1)
[ -z "$SWAP_USED" ] && SWAP_USED="unknown"

# --- 5. process state -------------------------------------------------------
SERVER_PID=$(pgrep -f 'scripts/vcontext-server\.js' 2>/dev/null | head -1)
[ -z "$SERVER_PID" ] && SERVER_PID=""

HEALTH_STATUS=""
HEALTH_HTTP_CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "${VCONTEXT_URL}/health" 2>/dev/null)
[ -z "$HEALTH_HTTP_CODE" ] && HEALTH_HTTP_CODE="000"
HEALTH_STATUS="$HEALTH_HTTP_CODE"

# --- 6. jetsam category/priority (best-effort, skip on fail) ----------------
JETSAM_INFO=""
LAUNCHD_DUMP=$(launchctl print "gui/$(id -u)/application.com.vcontext.server.$$" 2>/dev/null)
if [ -z "$LAUNCHD_DUMP" ]; then
  # actual server-spawned label varies; fallback to label-matching scan
  JETSAM_INFO=$(launchctl procinfo "$SERVER_PID" 2>/dev/null \
    | grep -iE 'jetsam|priority|category' | head -5 | tr '\n' ';' | tr -d '\t')
fi
[ -z "$JETSAM_INFO" ] && JETSAM_INFO="unavailable"

# --- 7. assemble JSON + POST to vcontext ------------------------------------
# Use python3 for safe JSON encoding (handles embedded quotes/newlines in
# WATCHDOG_LAST). Everything passed via env to avoid shell-quoting grief.
export TS WATCHDOG_LAST SIGKILL_137_COUNT EVIDENCE_GATE_COUNT SWAP_USED \
       SERVER_PID HEALTH_STATUS JETSAM_INFO P0A_CUTOVER

PAYLOAD=$(python3 <<'PY' 2>/dev/null
import json, os
# vcontext /store requires `content` to be a STRING (pre-serialized).
# Passing a dict returns: "content must be a string. Pre-serialize
# objects via JSON.stringify before POST /store."
content_obj = {
  "ts": os.environ.get("TS", ""),
  "p0a_cutover": os.environ.get("P0A_CUTOVER", ""),
  "watchdog_last": os.environ.get("WATCHDOG_LAST", "") or None,
  "sigkill_137_count_since_cutover": int(os.environ.get("SIGKILL_137_COUNT", "0") or 0),
  "evidence_gate_event_count_recent200": int(os.environ.get("EVIDENCE_GATE_COUNT", "0") or 0),
  "swap_used": os.environ.get("SWAP_USED", "unknown"),
  "server_pid": os.environ.get("SERVER_PID", "") or None,
  "health_http_code": os.environ.get("HEALTH_STATUS", "000"),
  "jetsam_info": os.environ.get("JETSAM_INFO", "unavailable"),
}
payload = {
  "type": "observation-probe",
  "session": "vcontext-server-health",
  "tags": ["observation-probe", "auto"],
  "content": json.dumps(content_obj),  # ← stringified per /store contract
}
print(json.dumps(payload))
PY
)

if [ -z "$PAYLOAD" ]; then
  # JSON assembly failed — exit silently (launchd must not see failure)
  exit 0
fi

# POST to /store. Timeout short: vcontext-server may be mid-restart.
# --fail so curl exits non-zero on HTTP 4xx/5xx; we swallow the exit below.
curl -sS -m 5 --fail \
  -H 'Content-Type: application/json' \
  -X POST "${VCONTEXT_URL}/store" \
  -d "$PAYLOAD" \
  >/dev/null 2>&1 || true

exit 0
