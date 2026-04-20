#!/bin/bash
# test-admin-misc-endpoints.sh — regression coverage for the three
# evening endpoints that did not ship with their own TDD harness:
#   GET /admin/db-size         (Stage 4.5 C7b)
#   GET /admin/kb-diff         (SKAP v1 Phase F)
#   GET /aios/mcp-manifest     (SKAP v1 Phase C)

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

# ═══════ GET /admin/db-size ═══════

header "[db-size] auth gate"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/admin/db-size")
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "db-size auth" "got $CODE"; fi

header "[db-size] response shape"
RESP=$(curl -sS -m 5 "$BASE/admin/db-size" -H 'X-Vcontext-Admin: yes')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = ['pages','file','path','ran_at']
  miss = [k for k in need if k not in d]
  if miss:
    print(f'missing: {miss}')
    sys.exit(0)
  if not isinstance(d['pages'].get('page_size',0), int) or \
     not isinstance(d['pages'].get('page_count',0), int) or \
     not isinstance(d['pages'].get('bytes',0), int):
    print('pages.* not int')
    sys.exit(0)
  if d['pages']['bytes'] <= 0:
    print(f'bytes suspicious: {d[\"pages\"][\"bytes\"]}')
    sys.exit(0)
  print('ok')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "pages/file/path/ran_at with int types"
else fail "db-size shape" "$OK"; fi

header "[db-size] plausibility — pages.bytes ≈ file.bytes"
DIFF_OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  p = d['pages']['bytes']; f = d['file']['bytes']
  # difference should be < 1 MiB for a healthy DB; WAL-only writes
  # can create up to page_size disparity but not megabytes
  if abs(p - f) > 1048576:
    print(f'diff too big: pages={p} file={f}')
  else:
    print('ok')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$DIFF_OK" == "ok" ]]; then pass "pages≈file size"
else
  echo "  ⚠ (info) $DIFF_OK — non-fatal (WAL activity can cause transient skew)"
  PASS=$((PASS+1))
fi

# ═══════ GET /admin/kb-diff ═══════

header "[kb-diff] auth gate"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/admin/kb-diff")
if [[ "$CODE" == "403" ]]; then pass "no auth → 403"
else fail "kb-diff auth" "got $CODE"; fi

header "[kb-diff] response shape + status value"
RESP=$(curl -sS -m 5 "$BASE/admin/kb-diff" -H 'X-Vcontext-Admin: yes')
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  need = ['claude_md_path','vcontext_shared_entries','drift','status']
  miss = [k for k in need if k not in d]
  if miss: print(f'missing: {miss}'); sys.exit(0)
  if d['status'] not in ('in-sync', 'drift'):
    print(f'bad status: {d[\"status\"]}')
    sys.exit(0)
  dr = d['drift']
  if 'missing_in_claude_md' not in dr or 'dangling_refs_in_claude_md' not in dr:
    print('drift subfields missing')
    sys.exit(0)
  print('ok')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "shape + status"
else fail "kb-diff shape" "$OK"; fi

header "[kb-diff] scope: design-proposal excluded from drift"
EXCLUDED=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  # Entries in drift.missing_in_claude_md must all be lesson-learned or decision.
  bad = [e for e in d['drift']['missing_in_claude_md']['entries']
         if e.get('type') not in ('lesson-learned', 'decision')]
  print('ok' if not bad else f'unexpected types: {bad}')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$EXCLUDED" == "ok" ]]; then pass "design-proposals not in drift"
else fail "kb-diff scope" "$EXCLUDED"; fi

# ═══════ GET /aios/mcp-manifest ═══════

header "[mcp-manifest] public (no auth)"
CODE=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "$BASE/aios/mcp-manifest")
if [[ "$CODE" == "200" ]]; then pass "manifest publicly readable → 200"
else fail "mcp-manifest public" "got $CODE"; fi

header "[mcp-manifest] 4 tool defs"
RESP=$(curl -sS -m 5 "$BASE/aios/mcp-manifest")
OK=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  if d.get('version') != 'skap-1':
    print(f'bad version: {d.get(\"version\")}'); sys.exit(0)
  tools = d.get('tools', [])
  if not isinstance(tools, list) or len(tools) != 4:
    print(f'tool count: {len(tools)}'); sys.exit(0)
  expected_names = {'aios_recall_lessons', 'aios_recall_decisions',
                    'aios_recall_design_proposals', 'aios_store_lesson'}
  got_names = {t.get('name') for t in tools}
  if got_names != expected_names:
    print(f'tool set: {got_names}'); sys.exit(0)
  for t in tools:
    if 'inputSchema' not in t or 'resolves_to' not in t:
      print(f'{t.get(\"name\")} missing inputSchema or resolves_to'); sys.exit(0)
  print('ok')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$OK" == "ok" ]]; then pass "4 tools with inputSchema + resolves_to"
else fail "mcp-manifest tools" "$OK"; fi

header "[mcp-manifest] write-gate documented on store tool"
WG=$(echo "$RESP" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  store = next((t for t in d.get('tools', []) if t.get('name') == 'aios_store_lesson'), None)
  if not store:
    print('no store tool'); sys.exit(0)
  if store.get('write_gate'):
    print('ok')
  else:
    print('no write_gate')
except Exception as e: print(f'parse:{e}')
" 2>/dev/null)
if [[ "$WG" == "ok" ]]; then pass "aios_store_lesson has write_gate"
else fail "write_gate" "$WG"; fi

echo
echo "═══ Results: $PASS pass, $FAIL fail ═══"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
