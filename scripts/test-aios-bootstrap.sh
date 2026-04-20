#!/bin/bash
# test-aios-bootstrap.sh — TDD for GET /aios/bootstrap (SKAP Phase A).
#
# spec: docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md §4.1

set -u
BASE=http://127.0.0.1:3150
PASS=0
FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1 — $2"; FAIL=$((FAIL+1)); }
header() { echo; echo "=== $1 ==="; }

header "sanity"
curl -sS -m 3 "$BASE/health" > /dev/null || { echo "abort"; exit 2; }
pass "server responsive"

# ── T1: no auth → 403 ──────────────────────────────────────────────
header "auth gate"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/aios/bootstrap")
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "auth" "got $CODE"; fi

# ── T2: default JSON response shape ────────────────────────────────
header "JSON response default"
RESP=$(curl -sS -m 5 "$BASE/aios/bootstrap" -H 'X-Vcontext-Admin: yes')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = {'version','generated_at','content_hash','total_entries','by_category','entries'}
  missing = [k for k in need if k not in d]
  if missing:
    print(f'missing: {missing}')
  elif d.get('version') != 'skap-1':
    print(f'bad version: {d[\"version\"]}')
  elif not isinstance(d['entries'], list):
    print('entries not list')
  else:
    print('ok')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "version=skap-1 + all required fields"
else fail "shape" "$OK"; fi

# ── T3: entries contain our 4 known lessons ────────────────────────
header "known lesson-learned entries present"
HAS_LESSONS=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  lesson_ids = set()
  for e in d.get('entries', []):
    if e.get('type') == 'lesson-learned':
      lesson_ids.add(e.get('id'))
  expected = {224681, 224682, 224683, 224684}
  if expected.issubset(lesson_ids):
    print('ok')
  else:
    missing = expected - lesson_ids
    print(f'missing: {missing}')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$HAS_LESSONS" == "ok" ]]; then pass "4 lessons (224681-224684) included"
else fail "lessons" "$HAS_LESSONS"; fi

# ── T4: categories filter ─────────────────────────────────────────
header "?categories=lesson-learned filter"
RESP_F=$(curl -sS -m 5 "$BASE/aios/bootstrap?categories=lesson-learned" -H 'X-Vcontext-Admin: yes')
ONLY=$(echo "$RESP_F" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  types = {e.get('type') for e in d.get('entries', [])}
  print('ok' if types == {'lesson-learned'} else f'types: {types}')
except Exception as e:
  print(f'parse:{e}')
" 2>/dev/null)
if [[ "$ONLY" == "ok" ]]; then pass "filter returns only lesson-learned"
else fail "filter" "$ONLY"; fi

# ── T5: format=system-prompt returns markdown ─────────────────────
header "format=system-prompt"
SP_RESP=$(curl -sS -m 5 "$BASE/aios/bootstrap?format=system-prompt" -H 'X-Vcontext-Admin: yes')
SIZE=$(echo "$SP_RESP" | wc -c | tr -d ' ')
IS_MD=$(echo "$SP_RESP" | head -c 200 | grep -q '^##' && echo "yes" || echo "no")
if [[ "$IS_MD" == "yes" ]] && [[ "$SIZE" -gt 100 ]] && [[ "$SIZE" -lt 16384 ]]; then
  pass "markdown returned, size=$SIZE bytes (<16KB cap)"
else
  fail "system-prompt" "is_md=$IS_MD size=$SIZE"
fi

# ── T6: ETag header present and stable ────────────────────────────
header "ETag support"
ETAG1=$(curl -sS -m 3 -D - "$BASE/aios/bootstrap" -H 'X-Vcontext-Admin: yes' -o /dev/null 2>&1 | grep -i '^etag:' | head -1 | awk '{print $2}' | tr -d '\r')
ETAG2=$(curl -sS -m 3 -D - "$BASE/aios/bootstrap" -H 'X-Vcontext-Admin: yes' -o /dev/null 2>&1 | grep -i '^etag:' | head -1 | awk '{print $2}' | tr -d '\r')
if [[ -n "$ETAG1" ]] && [[ "$ETAG1" == "$ETAG2" ]]; then
  pass "ETag stable across requests: $ETAG1"
else
  fail "etag" "etag1=$ETAG1 etag2=$ETAG2"
fi

# ── T7: If-None-Match → 304 ───────────────────────────────────────
header "conditional GET (304)"
if [[ -n "$ETAG1" ]]; then
  CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' \
    "$BASE/aios/bootstrap" \
    -H 'X-Vcontext-Admin: yes' -H "If-None-Match: $ETAG1")
  if [[ "$CODE" == "304" ]]; then pass "If-None-Match matching → 304"
  else fail "304" "got $CODE"; fi
else
  echo "  ⤬ skipped (no ETag)"
fi

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
