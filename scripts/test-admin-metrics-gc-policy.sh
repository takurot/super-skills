#!/bin/bash
# test-admin-metrics-gc-policy.sh — Stage 4.5 C4 TDD integration test:
#   GET  /admin/metrics/window
#   POST /admin/gc/dry-run
#   POST /admin/policy-check
#
# (docs/specs/2026-04-21-stage-4.5-spec.md §3.2.3 / §3.2.6 / §3.2.7)
#
# Written BEFORE implementation (RED).

set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

BASE=http://127.0.0.1:3150
PASS=0
FAIL=0
FAILED_TESTS=()

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1 — $2"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }
header() { echo; echo "=== $1 ==="; }

header "sanity"
curl -sS -m 3 "$BASE/health" > /dev/null || { echo "  ✗ abort"; exit 2; }
pass "server responsive"

# ═══════ GET /admin/metrics/window ═══════
header "[metrics] default (hours=1, metric=all)"
RESP=$(curl -sS -m 5 "$BASE/admin/metrics/window?hours=1&metric=all" -H 'X-Vcontext-Admin: yes')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = ['window_hours','api_metrics','entries','generated_at']
  missing = [k for k in need if k not in d]
  if missing:
    print(f'missing: {missing}')
  else:
    print('ok')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "metrics/window returns window_hours/api_metrics/entries/generated_at"
else fail "metrics shape" "$OK (raw: ${RESP:0:150})"; fi

header "[metrics] no auth → 403"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/admin/metrics/window?hours=1")
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "metrics auth" "got $CODE"; fi

header "[metrics] hours invalid → 400"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/admin/metrics/window?hours=-5" -H 'X-Vcontext-Admin: yes')
if [[ "$CODE" == "400" ]]; then pass "negative hours → 400"
else fail "metrics hours" "got $CODE"; fi

# ═══════ POST /admin/gc/dry-run ═══════
header "[gc/dry-run] default"
RESP=$(curl -sS -m 10 -X POST "$BASE/admin/gc/dry-run" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = ['candidates','total_bytes','window_end']
  missing = [k for k in need if k not in d]
  if missing:
    print(f'missing: {missing}')
  elif not isinstance(d['candidates'], list):
    print('candidates not list')
  else:
    print('ok')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "gc/dry-run returns candidates/total_bytes/window_end"
else fail "gc/dry-run shape" "$OK"; fi

header "[gc/dry-run] no auth → 403"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/gc/dry-run" -d '{}')
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "gc auth" "got $CODE"; fi

# ═══════ POST /admin/policy-check ═══════
header "[policy-check] default checks"
RESP=$(curl -sS -m 10 -X POST "$BASE/admin/policy-check" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' -d '{}')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = ['status','findings','ran_at']
  missing = [k for k in need if k not in d]
  if missing:
    print(f'missing: {missing}')
  elif d['status'] not in ('pass','warn','fail'):
    print(f'bad status: {d[\"status\"]}')
  elif not isinstance(d['findings'], list):
    print('findings not list')
  else:
    print('ok')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "policy-check returns status/findings/ran_at"
else fail "policy-check shape" "$OK"; fi

header "[policy-check] no auth → 403"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/policy-check" -d '{}')
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "policy auth" "got $CODE"; fi

header "[policy-check] specific checks array"
RESP=$(curl -sS -m 5 -X POST "$BASE/admin/policy-check" \
  -H 'X-Vcontext-Admin: yes' -H 'Content-Type: application/json' \
  -d '{"checks":["secret-scan"]}')
N=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(len(d.get('findings', [])))
except Exception:
  print(-1)
" 2>/dev/null)
if [[ "$N" == "1" ]]; then pass "single-check filter → 1 finding"
else fail "filter" "got N=$N"; fi

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && { echo "Failed:"; for t in "${FAILED_TESTS[@]}"; do echo "  • $t"; done; exit 1; }
exit 0
