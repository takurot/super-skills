#!/bin/bash
# crash-pattern-report.sh — produces the H5 evidence chain on demand.
#
# Summarizes the SIGKILL-137 → mmap-reclaim → mlx-embed-retry pattern
# documented in docs/analysis/2026-04-20-nightly-organic-crash-pattern.md.
#
# Use this:
#   1. Baseline before C11 deploy  — snapshot current pattern strength
#   2. After C11 deploy             — compare against baseline
#   3. Post-crash                   — confirm it's still the same pattern
#                                      or detect a new class
#
# Exit code:
#   0  — report generated successfully (regardless of findings)
#   1  — log file unreadable / server down (nothing to analyze)
#
# Usage:
#   scripts/crash-pattern-report.sh                 # default: last 30 min
#   scripts/crash-pattern-report.sh --window 2h     # last 2 hours
#   scripts/crash-pattern-report.sh --json          # machine-readable

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

LOG=/tmp/vcontext-server.log
WINDOW_KB=512  # last 512 KB ≈ last 30 min on busy systems
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --window) shift
      case "$1" in
        2h) WINDOW_KB=2048 ;;
        4h) WINDOW_KB=4096 ;;
        *)  WINDOW_KB=512  ;;
      esac
      ;;
    --json) JSON=1 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ ! -f "$LOG" ]; then
  echo "fatal: $LOG not found" >&2
  exit 1
fi

# Window slice
TAIL=$(tail -c $((WINDOW_KB * 1024)) "$LOG")

# ─── counters ─────────────────────────────────────────────────────
FILE_NOT_DB=$(echo "$TAIL" | grep -c 'file is not a database' || echo 0)
ALREADY_USE=$(echo "$TAIL" | grep -c 'database ssd is already in use' || echo 0)
MALFORMED=$(echo "$TAIL" | grep -c 'database disk image is malformed' || echo 0)
MLX_TIMEOUT=$(echo "$TAIL" | grep -c 'mlx embed timeout' || echo 0)
MLX_ECONNRESET=$(echo "$TAIL" | grep -c 'batch failed.*ECONNRESET' || echo 0)
WAL_BUSY=$(echo "$TAIL" | grep -c 'WAL checkpoint busy=1' || echo 0)
ANOMALY_CYCLES=$(echo "$TAIL" | grep -c '\[vcontext:alert\] [0-9]* anomalies detected' || echo 0)
SIGKILLS=$(echo "$TAIL" | grep -c 'exited with code 137' || echo 0)

# Embed backlog trend (first vs last occurrence in window)
BACKLOG_FIRST=$(echo "$TAIL" | grep -oE 'Embed backlog growing: [0-9]+' | head -1 | grep -oE '[0-9]+' || echo 0)
BACKLOG_LAST=$(echo "$TAIL" | grep -oE 'Embed backlog growing: [0-9]+' | tail -1 | grep -oE '[0-9]+' || echo 0)
BACKLOG_DELTA=$(( ${BACKLOG_LAST:-0} - ${BACKLOG_FIRST:-0} ))

# Crashes TOTAL lifetime
TOTAL_SIGKILLS=$(grep -c 'exited with code 137' "$LOG" 2>/dev/null || echo 0)

# Current server uptime
CURRENT_PID=$(pgrep -f vcontext-server.js | head -1)
UPTIME=$(ps -o etime= -p "${CURRENT_PID:-0}" 2>/dev/null | tr -d ' ' || echo 'unknown')

# Pattern verdict
# H5 is "confirmed" if we see the mmap-reclaim / MLX-stress co-occurrence.
# Note: BACKLOG_DELTA can read 0 spuriously when the server restart cycle
# is short enough that the "Embed backlog growing" log lines from the
# previous PID aren't in the window — so we don't require it for the
# confirmed verdict, only use it as supporting signal for "resolved".
VERDICT="inconclusive"
if [ "$SIGKILLS" -gt 0 ] && [ "$FILE_NOT_DB" -gt 50 ]; then
  VERDICT="H5 CONFIRMED: crashes + mmap-reclaim errors in window"
elif [ "$FILE_NOT_DB" -gt 50 ] && [ "$MLX_TIMEOUT" -gt 0 -o "$MLX_ECONNRESET" -gt 0 ]; then
  VERDICT="H5 PARTIAL: mmap-reclaim + MLX stress, no crash yet in window"
elif [ "$FILE_NOT_DB" -lt 10 ] && [ "$SIGKILLS" -eq 0 ]; then
  VERDICT="H5 RESOLVED: errors low + no crashes in window"
fi

# Severity badge — window crash rate
# crashes-per-window → approximate crashes per hour
CRASHES_PER_HOUR=$(( SIGKILLS * 3600 / (WINDOW_KB * 3) ))
SEVERITY="nominal"
if [ "$CRASHES_PER_HOUR" -gt 60 ]; then
  SEVERITY="critical: ${CRASHES_PER_HOUR}/h (>1 crash/min)"
elif [ "$CRASHES_PER_HOUR" -gt 6 ]; then
  SEVERITY="elevated: ${CRASHES_PER_HOUR}/h"
elif [ "$CRASHES_PER_HOUR" -gt 0 ]; then
  SEVERITY="degraded: ${CRASHES_PER_HOUR}/h"
fi

# ─── output ──────────────────────────────────────────────────────
if [ "$JSON" = "1" ]; then
  printf '{
  "window_kb": %d,
  "file_not_a_database": %d,
  "already_in_use": %d,
  "malformed": %d,
  "mlx_embed_timeout": %d,
  "mlx_batch_econnreset": %d,
  "wal_checkpoint_busy_1": %d,
  "anomaly_cycles": %d,
  "sigkill_137_in_window": %d,
  "sigkill_137_total": %d,
  "embed_backlog_first": %d,
  "embed_backlog_last": %d,
  "embed_backlog_delta": %d,
  "current_pid": %s,
  "current_uptime": "%s",
  "crashes_per_hour_est": %d,
  "severity": "%s",
  "verdict": "%s",
  "generated_at": "%s"
}\n' \
    "$WINDOW_KB" \
    "${FILE_NOT_DB:-0}" "${ALREADY_USE:-0}" "${MALFORMED:-0}" \
    "${MLX_TIMEOUT:-0}" "${MLX_ECONNRESET:-0}" "${WAL_BUSY:-0}" \
    "${ANOMALY_CYCLES:-0}" "${SIGKILLS:-0}" "${TOTAL_SIGKILLS:-0}" \
    "${BACKLOG_FIRST:-0}" "${BACKLOG_LAST:-0}" "$BACKLOG_DELTA" \
    "${CURRENT_PID:-null}" "${UPTIME}" \
    "$CRASHES_PER_HOUR" "$SEVERITY" \
    "$VERDICT" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  cat <<EOF

═══ crash-pattern-report — window=${WINDOW_KB}KB (~$(( WINDOW_KB / 17 )) min) ═══

Primary (mmap-reclaim class)
  file_not_a_database     : $FILE_NOT_DB
  malformed               : $MALFORMED
  already_in_use (ATTACH) : $ALREADY_USE

MLX embed stress signals
  embed_timeout           : $MLX_TIMEOUT
  batch_econnreset        : $MLX_ECONNRESET

SQLite contention
  wal_checkpoint_busy=1   : $WAL_BUSY

Embed backlog trend
  first observed          : ${BACKLOG_FIRST:-0}
  last  observed          : ${BACKLOG_LAST:-0}
  delta                   : $BACKLOG_DELTA $([ "$BACKLOG_DELTA" -gt 0 ] && echo "(GROWING)" || echo "(stable/shrinking)")

Anomaly-detector
  cycles in window        : $ANOMALY_CYCLES

SIGKILL-137
  in window               : $SIGKILLS
  total (all time)        : $TOTAL_SIGKILLS
  severity                : $SEVERITY

Current server
  PID                     : ${CURRENT_PID:-down}
  uptime                  : $UPTIME

Verdict: $VERDICT

EOF
fi

exit 0
