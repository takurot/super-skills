#!/usr/bin/env bash
# llm-jp-4-daily-watch.sh
# Daily research watch for LLM-jp-4 variants, DWQ, safety tuning, NII releases.
# Runs 4 SearXNG queries + 1 NII release page fetch, POSTs JSON to vcontext /store.
# SearXNG down → log skip + exit 0. vcontext down → exit 0 (no cascade).

set -u  # strict-ish: no pipefail (best-effort semantics), no -e (we handle errors)

VCONTEXT_URL="${VCONTEXT_URL:-http://127.0.0.1:3150}"
SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8888}"
NII_URL="https://llm-jp.nii.ac.jp/en/release-en/"

DATE="$(date +%Y-%m-%d)"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ---- 1. SearXNG health check ------------------------------------------------
if ! curl -s --max-time 5 "${SEARXNG_URL}/search?q=ping&format=json" >/dev/null 2>&1; then
  log "SearXNG down at ${SEARXNG_URL} — skip, exit 0"
  exit 0
fi

# ---- 2. Run 4 queries, collect top-3 results --------------------------------
QUERIES=(
  "mlx-community llm-jp-4 new variant"
  "\"llm-jp-4\" DWQ"
  "\"llm-jp-4\" safety RLHF instruct"
  "llm-jp release 2026"
)

# Build queries JSON array via jq
queries_json="[]"
for q in "${QUERIES[@]}"; do
  log "querying: ${q}"
  # URL-encode the query via jq
  q_encoded=$(printf '%s' "$q" | jq -sRr @uri)
  raw=$(curl -s --max-time 15 "${SEARXNG_URL}/search?q=${q_encoded}&format=json" 2>/dev/null || echo '{"results":[]}')
  # Extract top-3 results as array of {title,url,snippet}
  top3=$(printf '%s' "$raw" | jq -c '[.results[0:3][]? | {title: (.title // ""), url: (.url // ""), snippet: (.content // "")}]' 2>/dev/null || echo '[]')
  entry=$(jq -nc --arg q "$q" --argjson r "$top3" '{query: $q, top_results: $r}')
  queries_json=$(printf '%s' "$queries_json" | jq -c --argjson e "$entry" '. + [$e]')
done

# ---- 3. Fetch NII release page (best-effort) --------------------------------
nii_hash="null"
nii_body=$(curl -s --max-time 10 "$NII_URL" 2>/dev/null || echo "")
if [ -n "$nii_body" ]; then
  nii_hash=$(printf '%s' "$nii_body" | shasum -a 256 | awk '{print $1}')
  nii_hash="\"${nii_hash}\""
  log "NII release page fetched — sha256 ${nii_hash}"
else
  log "NII release page fetch failed — nii_release_page_hash=null"
fi

# ---- 4. Assemble payload ----------------------------------------------------
payload=$(jq -nc \
  --arg date "$DATE" \
  --argjson queries "$queries_json" \
  --argjson nii_hash "$nii_hash" \
  '{
    date: $date,
    watch_triggers_checked: ["dwq-variant", "safety-tuned", "32b-3bit-moe", "nii-larger-model"],
    queries: $queries,
    nii_release_page_hash: $nii_hash
  }')

# ---- 5. POST to vcontext /store ---------------------------------------------
store_body=$(jq -nc \
  --arg content "$payload" \
  '{
    type: "llm-jp-4-watch",
    content: $content,
    tags: ["llm-jp-4-watch", "research", "daily", "auto"]
  }')

http_code=$(curl -s --max-time 10 -o /tmp/vcontext-llm-jp-4-watch.last-response \
  -w "%{http_code}" \
  -X POST "${VCONTEXT_URL}/store" \
  -H "Content-Type: application/json" \
  -d "$store_body" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
  log "POST /store OK (HTTP ${http_code})"
else
  log "POST /store failed (HTTP ${http_code}) — no cascade, exit 0"
fi

exit 0
