#!/bin/bash
# test-c10-hardening.sh — Stage 4.5 C10 hardening verification.
#
# Verifies:
#   1. /store rejects non-string `content` with 400 (anti-[object Object])
#   2. /store rejects empty-string `content` with 400
#   3. /store accepts proper string `content`
#   4. No "[object Object]" rows remain in entries (boot sweep worked)

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

# ── T1: content is object (JSON nested) → 400 ────────────────────
header "[store] object content → 400"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/store" \
  -H 'Content-Type: application/json' \
  -d '{"type":"test-c10","content":{"nested":"object"},"session":"c10-test"}')
if [[ "$CODE" == "400" ]]; then pass "object content rejected with 400"
else fail "obj-reject" "got $CODE (expected 400)"; fi

# ── T2: content is number → 400 ───────────────────────────────────
header "[store] number content → 400"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/store" \
  -H 'Content-Type: application/json' \
  -d '{"type":"test-c10","content":123,"session":"c10-test"}')
if [[ "$CODE" == "400" ]]; then pass "number content rejected with 400"
else fail "num-reject" "got $CODE (expected 400)"; fi

# ── T3: content is empty string → 400 ────────────────────────────
header "[store] empty string content → 400"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/store" \
  -H 'Content-Type: application/json' \
  -d '{"type":"test-c10","content":"","session":"c10-test"}')
if [[ "$CODE" == "400" ]]; then pass "empty string rejected with 400"
else fail "empty-reject" "got $CODE (expected 400)"; fi

# ── T4: happy path — string content accepted ────────────────────
header "[store] string content → 200"
CODE=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/store" \
  -H 'Content-Type: application/json' \
  -d '{"type":"test-c10","content":"C10 test — hello","session":"c10-test"}')
if [[ "$CODE" == "200" ]] || [[ "$CODE" == "201" ]]; then pass "string content accepted ($CODE)"
else fail "happy" "got $CODE (expected 200 or 201)"; fi

# ── T5: no "[object Object]" rows in DB ──────────────────────────
header "no broken rows in DB"
BROKEN=$(sqlite3 -readonly ~/skills/data/vcontext-primary.sqlite \
  "SELECT COUNT(*) FROM entries WHERE content = '[object Object]';" 2>/dev/null)
if [[ "${BROKEN:-1}" == "0" ]]; then pass "zero [object Object] rows"
else fail "sweep" "found $BROKEN broken rows"; fi

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
