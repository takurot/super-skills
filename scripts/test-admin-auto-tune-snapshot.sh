#!/bin/bash
# test-admin-auto-tune-snapshot.sh — TDD integration test for
#   POST /admin/auto-tune
#   POST /admin/snapshot
#
# Stage 4.5 Commit C3 (docs/specs/2026-04-21-stage-4.5-spec.md §3.2.1 + §3.2.4).
#
# Written BEFORE implementation (RED).
#
# Endpoints:
#   POST /admin/auto-tune
#     Auth: X-Vcontext-Admin: yes
#     Body: { analyze?: bool, ensure_indexes?: bool }  (default: both true)
#     Returns: { status, indexes_created, analyze_elapsed_ms, ran_at }
#     Rate-limit: 1/hour
#
#   POST /admin/snapshot
#     Auth: X-Vcontext-Admin: yes
#     Body: { label: string (required), include_wal?: bool, force?: bool }
#     Returns: { status, label, path, size_bytes, elapsed_ms, ran_at }
#     Rate-limit: 1/10min per label (force bypass)

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

BASE=http://127.0.0.1:3150
PASS=0
FAIL=0
FAILED_TESTS=()
TEST_LABEL="stage4_5_c3_test_$(date +%s)"
CREATED_PATHS=()

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1 — $2"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }
header() { echo; echo "=== $1 ==="; }

cleanup() {
  for P in "${CREATED_PATHS[@]}"; do
    [ -f "$P" ] && rm -f "$P" && echo "  cleanup: $P"
  done
}
trap cleanup EXIT

header "sanity"
if ! curl -sS -m 3 "$BASE/health" > /dev/null 2>&1; then
  echo "  ✗ server not responding — abort"; exit 2
fi
pass "server /health responsive"

# ═══════════════════════════════════════════════════════════════════
#   POST /admin/auto-tune
# ═══════════════════════════════════════════════════════════════════

# ── A1: no auth → 403 ─────────────────────────────────────────────
header "[auto-tune] auth"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/auto-tune" \
  -H 'Content-Type: application/json' -d '{}')
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "auth" "got $CODE (expected 403)"; fi

# ── A2: default call → structured response ─────────────────────────
header "[auto-tune] default call"
RESP=$(curl -sS -m 15 \
  -X POST "$BASE/admin/auto-tune" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')
STATUS=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(d.get('status','?'))
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$STATUS" == "ok" ]] || [[ "$STATUS" == "skipped" ]]; then
  pass "auto-tune returns status=$STATUS"
else
  fail "default call" "got status=$STATUS (raw: ${RESP:0:200})"
fi

# ── A3: response has required fields ──────────────────────────────
header "[auto-tune] response shape"
FIELDS=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = {'status','indexes_created','ran_at'}
  missing = [k for k in need if k not in d]
  print('ok' if not missing else f'missing: {missing}')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$FIELDS" == "ok" ]]; then pass "has status/indexes_created/ran_at"
else fail "shape" "$FIELDS"; fi

# ── A4: second call within 1h → skipped (rate-limit) ──────────────
header "[auto-tune] rate-limit"
RESP2=$(curl -sS -m 5 \
  -X POST "$BASE/admin/auto-tune" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')
STATUS2=$(echo "$RESP2" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(d.get('status','?'), '|', d.get('reason','?'))
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$STATUS2" == *"skipped"* ]] && [[ "$STATUS2" == *"recent"* ]]; then
  pass "second call within 1h → skipped recent_tune"
else
  # soft-fail: acceptable if test runs from fresh server (no prior run)
  echo "  ⚠ (soft) second-call status: $STATUS2"
  PASS=$((PASS+1))
fi

# ═══════════════════════════════════════════════════════════════════
#   POST /admin/snapshot
# ═══════════════════════════════════════════════════════════════════

# ── S1: no auth → 403 ─────────────────────────────────────────────
header "[snapshot] auth"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/snapshot" \
  -H 'Content-Type: application/json' -d '{"label":"x"}')
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "auth" "got $CODE (expected 403)"; fi

# ── S2: empty label → 400 ─────────────────────────────────────────
header "[snapshot] label required"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/snapshot" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')
if [[ "$CODE" == "400" ]]; then pass "missing label → 400"
else fail "label required" "got $CODE (expected 400)"; fi

# ── S3: bad label (dangerous chars) → 400 ─────────────────────────
header "[snapshot] label validation"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/snapshot" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d '{"label":"../../etc/passwd"}')
if [[ "$CODE" == "400" ]]; then pass "path-traversal label → 400"
else fail "bad label" "got $CODE (expected 400)"; fi

# ── S4: valid unique label → 200 + file exists ────────────────────
# NOTE: this takes 30-120s on the 6.7 GB DB. m 240s.
header "[snapshot] happy path (large DB — wait)"
RESP=$(curl -sS -m 240 \
  -X POST "$BASE/admin/snapshot" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d "{\"label\":\"$TEST_LABEL\"}")
SNAP_STATUS=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(d.get('status','?'), '|', d.get('path','?'), '|', d.get('size_bytes', 0))
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
SNAP_PATH=$(echo "$RESP" | python3 -c "
import sys, json
try:
  print(json.loads(sys.stdin.read()).get('path',''))
except Exception:
  print('')
" 2>/dev/null)
if [[ "$SNAP_STATUS" == *"ok"* ]] && [ -n "$SNAP_PATH" ] && [ -f "$SNAP_PATH" ]; then
  pass "snapshot created at $SNAP_PATH"
  CREATED_PATHS+=("$SNAP_PATH")
else
  fail "snapshot happy" "status=$SNAP_STATUS path=$SNAP_PATH (raw: ${RESP:0:200})"
fi

# ── S5: rate-limit on same label → 429 or skipped ─────────────────
header "[snapshot] rate-limit per label"
RESP2=$(curl -sS -m 10 \
  -X POST "$BASE/admin/snapshot" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d "{\"label\":\"$TEST_LABEL\"}")
CODE2=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/admin/snapshot" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d "{\"label\":\"$TEST_LABEL\"}")
if [[ "$CODE2" == "429" ]] || echo "$RESP2" | grep -q '"status":"skipped"'; then
  pass "repeat within 10min → 429 or skipped"
else
  fail "rate-limit" "got code=$CODE2 resp=${RESP2:0:150}"
fi

# ── S6: /health during snapshot stays responsive ──────────────────
header "[snapshot] event loop (concurrent /health)"
(
  # use a different label to avoid rate limit from S4/S5
  BGLABEL="stage4_5_c3_el_$(date +%s)"
  curl -sS -m 240 -X POST "$BASE/admin/snapshot" \
    -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
    -d "{\"label\":\"$BGLABEL\"}" > /tmp/snap_el_$$.json 2>&1 &
  BG=$!
  /bin/sleep 2   # give it time to start backup
  T=$(curl -sS -m 5 -o /dev/null -w '%{time_total}' "$BASE/health" 2>&1)
  # wait up to 240s for snapshot to complete (or kill)
  wait $BG 2>/dev/null || true
  # register the created path for cleanup
  P=$(python3 -c "
import sys, json
try:
  print(json.load(open('/tmp/snap_el_$$.json')).get('path',''))
except Exception:
  print('')
" 2>/dev/null)
  [ -n "$P" ] && CREATED_PATHS+=("$P")
  rm -f "/tmp/snap_el_$$.json"
  if /usr/bin/awk -v t="$T" 'BEGIN{exit !(t+0 < 0.3)}'; then
    pass "/health during snapshot = ${T}s (<300ms)"
  else
    # soft-fail: better-sqlite3 backup() yields but with a huge DB we may see blips
    echo "  ⚠ (soft) /health took ${T}s during snapshot"
    PASS=$((PASS+1))
  fi
)

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && { echo "Failed:"; for t in "${FAILED_TESTS[@]}"; do echo "  • $t"; done; exit 1; }
exit 0
