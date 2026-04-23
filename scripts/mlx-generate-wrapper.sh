#!/bin/bash
# MLX Generate Server wrapper — mlx_lm.server with speculative decoding
# Qwen3-8B (main) + Qwen3-0.6B (draft) = 1.3-2x faster, 100% accuracy preserved

set -euo pipefail

export PATH="/Users/mitsuru_nakajima/.pyenv/versions/3.14.4/bin:$PATH"

MODEL="${MLX_GENERATE_MODEL:-mlx-community/Qwen3-8B-4bit}"
DRAFT_MODEL="${MLX_DRAFT_MODEL:-Qwen/Qwen3-0.6B-MLX-4bit}"
PORT="${MLX_GENERATE_PORT:-3162}"
HOST="127.0.0.1"

echo "[mlx-generate-wrapper] Starting mlx_lm.server with speculative decoding"
echo "[mlx-generate-wrapper] main=${MODEL} draft=${DRAFT_MODEL} port=${PORT}"
exec python3 -m mlx_lm.server \
  --model "${MODEL}" \
  `# --draft-model "${DRAFT_MODEL}"       # TEMP disabled 2026-04-23 LL1 test` \
  `# --num-draft-tokens 5                 # TEMP disabled alongside draft-model` \
  --prompt-cache-size 8 \
  --prompt-cache-bytes 1073741824 \
  --prompt-concurrency 6 \
  --decode-concurrency 24 \
  --port "${PORT}" \
  --host "${HOST}"
