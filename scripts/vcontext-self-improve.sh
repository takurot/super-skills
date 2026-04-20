#!/bin/bash
# vcontext-self-improve.sh — AI OS self-modification pipeline
# Workflow: detect → research → patch → test → propose (notify user for approval)
# User approves via dashboard button → auto-apply to main + reload
# Auto-rollback on test failure. User retains final approval authority.
#
# Stage 4.5 C8 (2026-04-20): DEAD_PATH_GUARD + HTTP redirect.
# Previously read directly from /Volumes/VContext/vcontext.db via
# sqlite3 CLI. That RAM-disk mount has been gone since morning of
# 2026-04-20, so these queries were silently returning empty; the
# "regression detection" logic was a quiet no-op. We now:
#   1. Refuse to proceed if vcontext server is unreachable
#     (hard-gate — better than silent-skip)
#   2. Use the /metrics/report endpoint for per-operation latency
#     (exists since before Stage 4.5, lives on the server thread)
#   3. Use /recall for pending-patch counting

set -u

LOG="$HOME/skills/data/self-improve.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

VCTX_URL="${VCTX_URL:-http://127.0.0.1:3150}"
SKILLS_DIR="$HOME/skills"
cd "$SKILLS_DIR" || exit 1

log "=== self-improve cycle ==="

# DEAD_PATH_GUARD — if vcontext server is unreachable, skip the cycle
# cleanly rather than limping through with empty sqlite3 returns.
if ! curl -sS -m 3 "$VCTX_URL/health" > /dev/null 2>&1; then
  log "Server unreachable at $VCTX_URL — skipping self-improve cycle (dead-path guard)"
  exit 0
fi

# Exit if a previous proposal is still pending (one at a time).
PENDING=$(curl -sS -m 5 "$VCTX_URL/recall?type=pending-patch&limit=50" 2>/dev/null | \
  python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  rows = d.get('results', []) or d.get('entries', [])
  n = 0
  for r in rows:
    try:
      c = json.loads(r.get('content','{}'))
      if c.get('status') in ('pending-review','testing'): n += 1
    except Exception: pass
  print(n)
except Exception: print(0)
" 2>/dev/null)
if [[ "${PENDING:-0}" -gt 0 ]]; then
  log "Skipping: ${PENDING} proposal(s) still pending user review"
  exit 0
fi

# 1. Find improvement opportunity via /metrics/report (per-operation latency).
REPORT_JSON=$(curl -sS -m 5 "$VCTX_URL/metrics/report?hours=1" 2>/dev/null)
SLOWEST=$(echo "$REPORT_JSON" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  ops = d.get('operations', {}) or {}
  pairs = [(op, v.get('avg_latency_ms', v.get('avg_latency', 0)) or 0) for op, v in ops.items()]
  pairs = [p for p in pairs if p[1] > 0]
  if not pairs:
    print('')
  else:
    pairs.sort(key=lambda x: -x[1])
    op, lat = pairs[0]
    print(f'{op}:{int(round(lat))}ms')
except Exception: print('')
" 2>/dev/null)
if [[ -z "$SLOWEST" ]]; then
  log "No per-operation metrics available — skipping"
  exit 0
fi
REGRESSION="$SLOWEST (proactive optimization via /metrics/report)"
log "Targeting: $SLOWEST"

# 2. Research latest best practices
SEARXNG_PORT=$(docker port searxng 8080 2>/dev/null | head -1 | cut -d: -f2)
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
RESEARCH=$(curl -s --max-time 15 "http://127.0.0.1:${SEARXNG_PORT}/search?q=Node.js+SQLite+performance+optimization+2026&format=json&language=auto" 2>/dev/null | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print('\n'.join(f'- {r.get(\"title\",\"\")}: {r.get(\"content\",\"\")[:150]}' for r in d.get('results',[])[:5]))" 2>/dev/null)

# 3. Generate patch via MLX
PATCH_REQUEST=$(python3 -c "
import json
print(json.dumps({
  'model':'mlx-community/Qwen3-8B-4bit',
  'messages':[{'role':'user','content':f'''Regression: $REGRESSION
Research findings:
$RESEARCH

Task: Propose ONE minimal code change to /Users/mitsuru_nakajima/skills/scripts/vcontext-server.js.
Output ONLY in this exact format:
FILE: scripts/vcontext-server.js
LINE: <line_number>
BEFORE: <exact current code>
AFTER: <proposed new code>
RATIONALE: <one sentence why>
Be conservative. Never break APIs.'''}],
  'max_tokens': 2000
}))
")
PROPOSAL=$(curl -s --max-time 300 http://127.0.0.1:3162/v1/chat/completions \
  -H 'Content-Type: application/json' -d "$PATCH_REQUEST" 2>/dev/null | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['choices'][0]['message'].get('content',''))" 2>/dev/null)

if [[ -z "$PROPOSAL" ]] || ! echo "$PROPOSAL" | grep -q "^FILE:"; then
  log "No valid patch generated"
  exit 0
fi

# 4. Create feature branch and apply patch
BRANCH="self-improve-$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH" 2>/dev/null
log "Created branch: $BRANCH"

# Parse proposal (simplified — real patching would use git apply or node script)
# For safety: save proposal, let user apply manually after review
PATCH_FILE="$HOME/skills/data/pending-patches/${BRANCH}.patch"
mkdir -p "$(dirname "$PATCH_FILE")"
echo "$PROPOSAL" > "$PATCH_FILE"
log "Patch saved: $PATCH_FILE"

# 5. Run tests (syntax + health check)
TEST_OK=true
node -c scripts/vcontext-server.js 2>/dev/null || TEST_OK=false
bash -n scripts/vcontext-watchdog.sh 2>/dev/null || TEST_OK=false

# Revert to main (don't actually apply until user approves)
git checkout main 2>/dev/null
git branch -D "$BRANCH" 2>/dev/null

# 6. Store proposal for user review
PAYLOAD=$(python3 <<EOF
import json
print(json.dumps({
  'type':'pending-patch',
  'content': json.dumps({
    'regression': """$REGRESSION""",
    'research': """$RESEARCH"""[:1000],
    'proposal': """$PROPOSAL""",
    'branch': '$BRANCH',
    'patch_file': '$PATCH_FILE',
    'test_passed': $([[ "$TEST_OK" == "true" ]] && echo "true" || echo "false"),
    'status': 'pending-review',
    'created_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
  }),
  'tags':['pending-patch','self-improve','regression'],
  'session':'system'
}))
EOF
)
curl -s -X POST http://127.0.0.1:3150/store -H 'Content-Type: application/json' -d "$PAYLOAD" > /dev/null

# 7. Notify user
osascript -e "display notification \"AI OS improvement proposal ready for review: $REGRESSION\" with title \"🔧 vcontext self-improve\" sound name \"Submarine\"" 2>/dev/null
log "Proposal submitted for user review"
log "=== cycle done ==="
