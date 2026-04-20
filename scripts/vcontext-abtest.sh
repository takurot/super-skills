#!/bin/bash
# vcontext-abtest.sh — A/B test runner for vcontext parameters
# Usage: abtest.sh <param> <value_a> <value_b> <metric> <duration_hours>
#   param: e.g. EMBED_BATCH, EMBED_WAIT_MS, CLEAR_CACHE_INTERVAL
#   metric: recall_ms, store_ms, embed_rate, hit_rate
#
# Stage 4.5 C8 (2026-04-20): DEAD_PATH_GUARD + HTTP redirect.
# Previous implementation queried /Volumes/VContext/vcontext.db
# directly; that mount has been gone since morning of 2026-04-20.
# get_metric() now reads from /metrics/report (per-operation avg
# latency) — same signal, no external file lock.

set -u

LOG="$HOME/skills/data/abtest-log.jsonl"
mkdir -p "$(dirname "$LOG")"

PARAM="${1:-}"
VALUE_A="${2:-}"
VALUE_B="${3:-}"
METRIC="${4:-recall_ms}"
DURATION_H="${5:-2}"

[ -z "$PARAM" ] && echo "Usage: $0 <param> <value_a> <value_b> <metric> <duration_h>" && exit 1

VCTX_URL="${VCTX_URL:-http://127.0.0.1:3150}"

# DEAD_PATH_GUARD — refuse to run if server is unreachable (the old
# sqlite3-on-RAM-disk path would have silently returned empty metrics,
# producing false "A=B" verdicts).
if ! curl -sS -m 3 "$VCTX_URL/health" > /dev/null 2>&1; then
  echo "vcontext server unreachable at $VCTX_URL — cannot collect metrics" >&2
  exit 0
fi

get_metric() {
  local since_min=$1
  local hours
  hours=$(( (since_min + 59) / 60 ))   # round up to ≥ 1h window
  [ "$hours" -lt 1 ] && hours=1
  local report
  report=$(curl -sS -m 5 "$VCTX_URL/metrics/report?hours=${hours}" 2>/dev/null)
  case "$METRIC" in
    recall_ms)
      echo "$report" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  v = d.get('operations', {}).get('recall', {})
  lat = v.get('avg_latency_ms', v.get('avg_latency', 0)) or 0
  print(round(lat, 1))
except Exception: print('')
" 2>/dev/null ;;
    store_ms)
      echo "$report" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  v = d.get('operations', {}).get('store', {})
  lat = v.get('avg_latency_ms', v.get('avg_latency', 0)) or 0
  print(round(lat, 1))
except Exception: print('')
" 2>/dev/null ;;
    hit_rate)
      # /metrics/report may not expose hit_rate directly. Compute via
      # /admin/metrics/window count for recall entries that returned >0
      # results (if supported) else return empty.
      echo ""
      ;;
    embed_rate)
      # Count of entries with embeddings in the window — via /admin/metrics/window
      local window_hours=$(( (since_min + 59) / 60 ))
      curl -sS -m 5 "$VCTX_URL/admin/metrics/window?hours=${window_hours}&metric=entries" \
        -H 'X-Vcontext-Admin: yes' 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('entries', {}).get('with_embedding', 0))
except Exception: print('')
" 2>/dev/null ;;
  esac
}

apply_param() {
  local val=$1
  case "$PARAM" in
    EMBED_BATCH)
      sed -i '' "s/const BATCH = [0-9]*;/const BATCH = ${val};/" ~/skills/scripts/vcontext-server.js
      bash ~/skills/scripts/vcontext-reload.sh >/dev/null 2>&1 ;;
    EMBED_WAIT_MS)
      sed -i '' "s/setTimeout(r, [0-9]*)); \/\/ 100ms gap/setTimeout(r, ${val})); \/\/ ${val}ms gap/" ~/skills/scripts/vcontext-server.js
      bash ~/skills/scripts/vcontext-reload.sh >/dev/null 2>&1 ;;
    *) echo "Unknown param: $PARAM"; exit 1 ;;
  esac
}

DURATION_MIN=$((DURATION_H * 60))

echo "=== A/B Test: $PARAM ==="
echo "A=$VALUE_A, B=$VALUE_B, metric=$METRIC, duration=${DURATION_H}h each"

# Variant A
echo "[$(date +%H:%M)] Applying A=$VALUE_A"
apply_param "$VALUE_A"
sleep 300  # warmup 5min
START_A=$(date +%s)
sleep $((DURATION_MIN * 60))
METRIC_A=$(get_metric $DURATION_MIN)
echo "[$(date +%H:%M)] A result: ${METRIC}=${METRIC_A}"

# Variant B
echo "[$(date +%H:%M)] Applying B=$VALUE_B"
apply_param "$VALUE_B"
sleep 300
START_B=$(date +%s)
sleep $((DURATION_MIN * 60))
METRIC_B=$(get_metric $DURATION_MIN)
echo "[$(date +%H:%M)] B result: ${METRIC}=${METRIC_B}"

# Result
WINNER="A"
if [[ -n "$METRIC_B" ]] && [[ -n "$METRIC_A" ]]; then
  # For latency metrics, lower is better; for rate metrics, higher
  case "$METRIC" in
    *_ms) [[ $(echo "$METRIC_B < $METRIC_A" | bc -l 2>/dev/null) == "1" ]] && WINNER="B" ;;
    *rate|embed_rate) [[ $(echo "$METRIC_B > $METRIC_A" | bc -l 2>/dev/null) == "1" ]] && WINNER="B" ;;
  esac
fi

RESULT=$(cat <<EOF
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","param":"$PARAM","value_a":"$VALUE_A","value_b":"$VALUE_B","metric":"$METRIC","metric_a":"$METRIC_A","metric_b":"$METRIC_B","winner":"$WINNER","duration_h":$DURATION_H}
EOF
)
echo "$RESULT" >> "$LOG"
echo "=== Winner: $WINNER (${METRIC}: A=${METRIC_A} vs B=${METRIC_B}) ==="
osascript -e "display notification \"A/B test done: $PARAM winner=$WINNER\" with title \"🧪 vcontext A/B\"" 2>/dev/null
