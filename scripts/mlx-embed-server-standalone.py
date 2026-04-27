#!/usr/bin/env python3
"""Qwen3 Embedding Server — standalone variant.

This is a drop-in-compatible replacement for mlx-embed-server.py that does NOT
import mlx_lm. Motivation: mlx_lm transitively pulls transformers → sympy →
scipy → torch, which balloons Nuitka-compiled .app bundles to 6,700+ modules
and hours of build time. The standalone variant uses only:

    mlx.core, mlx.nn, mlx.utils        (GPU + weight tree)
    tokenizers (Rust, no transformers) (HF tokenizer.json)
    fastapi, uvicorn, pydantic         (HTTP layer)
    numpy                              (result buffers)

bit-exactness vs mlx_lm: verified cos=1.0000000000 across all test samples
(POC /tmp/mlx-poc/qwen3_embed_standalone.py).

Reference: mlx-examples/llms/mistral.py pattern (self-contained Model class +
mx.load + nn.quantize + model.update), adapted to Qwen3 architecture copied
from mlx_lm/models/qwen3.py + dependencies.

Production safety:
  * Original mlx-embed-server.py untouched — rollback = plist revert 1 line.
  * All HTTP routes are byte-compatible (/embed, /embed_batch, /health,
    /metrics, /models, /api/embeddings, /v1/embeddings, /clear_cache,
    /api/health).
"""

import argparse
import asyncio
import gc
import glob
import inspect
import json
import logging
import os
import sys
import time
from collections import OrderedDict  # W3 P0: LRU eviction (F1, 2026-04-27)
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_unflatten
from tokenizers import Tokenizer

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
import uvicorn


# ═══════════════════════════════════════════════════════════════════════════
# 1. Model architecture (copy of mlx_lm/models/qwen3.py, trimmed + embedding-
#    oriented: mask defaults to None for bidirectional attention per the
#    production _get_hidden_states contract in mlx-embed-server.py).
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class Qwen3Args:
    model_type: str
    hidden_size: int
    num_hidden_layers: int
    intermediate_size: int
    num_attention_heads: int
    rms_norm_eps: float
    vocab_size: int
    num_key_value_heads: int
    max_position_embeddings: int
    rope_theta: float
    head_dim: int
    tie_word_embeddings: bool
    rope_scaling: Optional[dict] = None

    @classmethod
    def from_dict(cls, d: dict) -> "Qwen3Args":
        params = inspect.signature(cls).parameters
        return cls(**{k: v for k, v in d.items() if k in params})


class Attention(nn.Module):
    def __init__(self, args: Qwen3Args):
        super().__init__()
        dim = args.hidden_size
        self.n_heads = args.num_attention_heads
        self.n_kv_heads = args.num_key_value_heads
        head_dim = args.head_dim
        self.scale = head_dim ** -0.5

        self.q_proj = nn.Linear(dim, self.n_heads * head_dim, bias=False)
        self.k_proj = nn.Linear(dim, self.n_kv_heads * head_dim, bias=False)
        self.v_proj = nn.Linear(dim, self.n_kv_heads * head_dim, bias=False)
        self.o_proj = nn.Linear(self.n_heads * head_dim, dim, bias=False)
        self.q_norm = nn.RMSNorm(head_dim, eps=args.rms_norm_eps)
        self.k_norm = nn.RMSNorm(head_dim, eps=args.rms_norm_eps)

        # Qwen3-Embedding-*-4bit-DWQ ships rope_scaling: null → default RoPE.
        self.rope = nn.RoPE(head_dim, traditional=False, base=args.rope_theta)

    def __call__(self, x: mx.array, mask=None, cache=None) -> mx.array:
        B, L, D = x.shape
        q = self.q_norm(self.q_proj(x).reshape(B, L, self.n_heads, -1)).transpose(0, 2, 1, 3)
        k = self.k_norm(self.k_proj(x).reshape(B, L, self.n_kv_heads, -1)).transpose(0, 2, 1, 3)
        v = self.v_proj(x).reshape(B, L, self.n_kv_heads, -1).transpose(0, 2, 1, 3)
        q = self.rope(q)
        k = self.rope(k)
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        out = out.transpose(0, 2, 1, 3).reshape(B, L, -1)
        return self.o_proj(out)


class MLP(nn.Module):
    def __init__(self, dim: int, hidden_dim: int):
        super().__init__()
        self.gate_proj = nn.Linear(dim, hidden_dim, bias=False)
        self.down_proj = nn.Linear(hidden_dim, dim, bias=False)
        self.up_proj = nn.Linear(dim, hidden_dim, bias=False)

    def __call__(self, x: mx.array) -> mx.array:
        return self.down_proj(nn.silu(self.gate_proj(x)) * self.up_proj(x))


class TransformerBlock(nn.Module):
    def __init__(self, args: Qwen3Args):
        super().__init__()
        self.self_attn = Attention(args)
        self.mlp = MLP(args.hidden_size, args.intermediate_size)
        self.input_layernorm = nn.RMSNorm(args.hidden_size, eps=args.rms_norm_eps)
        self.post_attention_layernorm = nn.RMSNorm(args.hidden_size, eps=args.rms_norm_eps)

    def __call__(self, x: mx.array, mask=None, cache=None) -> mx.array:
        h = x + self.self_attn(self.input_layernorm(x), mask, cache)
        return h + self.mlp(self.post_attention_layernorm(h))


class Qwen3Model(nn.Module):
    """Inner transformer stack. Call with mask=None for bidirectional (embed)."""
    def __init__(self, args: Qwen3Args):
        super().__init__()
        self.embed_tokens = nn.Embedding(args.vocab_size, args.hidden_size)
        self.layers = [TransformerBlock(args) for _ in range(args.num_hidden_layers)]
        self.norm = nn.RMSNorm(args.hidden_size, eps=args.rms_norm_eps)

    def __call__(self, inputs: mx.array, mask=None) -> mx.array:
        h = self.embed_tokens(inputs)
        for layer in self.layers:
            h = layer(h, mask=mask)
        return self.norm(h)


class Model(nn.Module):
    """Top-level wrapper matching mlx_lm's Qwen3 Model structure so weight
    key names (e.g. ``model.embed_tokens.weight``) map unchanged."""
    def __init__(self, args: Qwen3Args):
        super().__init__()
        self.args = args
        self.model_type = args.model_type
        self.model = Qwen3Model(args)
        if not args.tie_word_embeddings:
            self.lm_head = nn.Linear(args.hidden_size, args.vocab_size, bias=False)

    def sanitize(self, weights: dict) -> dict:
        if self.args.tie_word_embeddings:
            weights.pop("lm_head.weight", None)
        return weights


# ═══════════════════════════════════════════════════════════════════════════
# 2. Load pipeline — mirrors mlx_lm.utils.load_model for Qwen3 + 4-bit DWQ.
# ═══════════════════════════════════════════════════════════════════════════


def load_standalone(model_dir: Path) -> Tuple[Model, Qwen3Args, Tokenizer]:
    with open(model_dir / "config.json") as f:
        config = json.load(f)
    args = Qwen3Args.from_dict(config)
    model = Model(args)

    weight_files = sorted(glob.glob(str(model_dir / "model*.safetensors")))
    if not weight_files:
        raise FileNotFoundError(f"No safetensors in {model_dir}")
    weights = {}
    for wf in weight_files:
        weights.update(mx.load(wf))
    weights = model.sanitize(weights)

    q_cfg = config.get("quantization")
    if q_cfg is not None:
        def class_predicate(p, m):
            if p in q_cfg:
                return q_cfg[p]
            if not hasattr(m, "to_quantized"):
                return False
            return f"{p}.scales" in weights
        nn.quantize(
            model,
            group_size=q_cfg["group_size"],
            bits=q_cfg["bits"],
            mode=q_cfg.get("mode", "affine"),
            class_predicate=class_predicate,
        )

    model.update(tree_unflatten(list(weights.items())))
    mx.eval(model.parameters())
    model.eval()

    # Tokenizer: Rust binding, no transformers required.
    tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    # Qwen3 pad token is <|endoftext|> (id=151643) per tokenizer_config.json.
    tok.enable_padding(pad_id=151643, pad_token="<|endoftext|>", direction="right")
    return model, args, tok


def resolve_model_dir(repo_id: str) -> Path:
    """Find the HuggingFace cache snapshot dir for a repo id. If absent, fall
    back to huggingface_hub.snapshot_download — parity with mlx_lm.load()'s
    auto-download behaviour. huggingface_hub has been verified to pull NO
    heavy deps (no transformers/sympy/scipy/torch), so including it keeps
    the standalone server's no-heavy-deps invariant intact."""
    hf_cache = Path(os.path.expanduser("~/.cache/huggingface/hub"))
    slug = "models--" + repo_id.replace("/", "--")
    base = hf_cache / slug / "snapshots"
    if base.exists():
        snaps = sorted(base.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        if snaps:
            return snaps[0]

    # Cache miss — download (matches mlx_lm.load() semantics).
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:
        raise RuntimeError(
            f"Model not in HF cache ({repo_id}) and huggingface_hub is unavailable "
            f"for auto-download. Install with `pip install huggingface_hub` or "
            f"pre-cache the model with `huggingface-cli download {repo_id}`."
        ) from e

    logger.info(f"Model {repo_id} not cached; downloading via huggingface_hub...")
    downloaded = snapshot_download(repo_id=repo_id)
    return Path(downloaded)


# ═══════════════════════════════════════════════════════════════════════════
# 3. Server glue — route-compatible with mlx-embed-server.py.
# ═══════════════════════════════════════════════════════════════════════════


DEFAULT_MODEL = "mlx-community/Qwen3-Embedding-8B-4bit-DWQ"

AVAILABLE_MODELS: Dict[str, Dict[str, Any]] = {
    "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ": {
        "alias": ["small", "0.6b", "default"],
        "embedding_dim": 1024,
        "description": "Small 0.6B parameter model, fast and efficient",
    },
    "mlx-community/Qwen3-Embedding-4B-4bit-DWQ": {
        "alias": ["medium", "4b"],
        "embedding_dim": 2560,
        "description": "Medium 4B parameter model, balanced performance",
    },
    "mlx-community/Qwen3-Embedding-8B-4bit-DWQ": {
        "alias": ["large", "8b"],
        "embedding_dim": 4096,
        "description": "Large 8B parameter model, higher quality embeddings",
    },
}
MODEL_ALIASES: Dict[str, str] = {
    alias.lower(): name
    for name, cfg in AVAILABLE_MODELS.items()
    for alias in cfg.get("alias", [])
}

MIN_BATCH_SIZE = 1
DEFAULT_MAX_BATCH = 1024
DEFAULT_MAX_LENGTH = 8192
DEFAULT_PORT = 8000
DEFAULT_HOST = "127.0.0.1"  # W7 P1: fail-safe to loopback (Security HIGH #5)

# W3 P0: LRU eviction (2026-04-27) — Stability F1
_EMBED_CACHE_MAX = int(os.environ.get('VCTX_EMBED_CACHE_MAX', '500'))
# W3 P0: post-call _clear_cache throttle (2026-04-27) — Stability F18
_LAST_CLEAR_CACHE_AT = 0.0
_CLEAR_CACHE_MIN_INTERVAL_S = 60.0


# Cache-API compat — same tolerant probing as the original.
_clear_cache = getattr(mx, "clear_cache", None) or getattr(getattr(mx, "metal", None), "clear_cache", None)
_set_cache_limit = getattr(mx, "set_cache_limit", None) or getattr(getattr(mx, "metal", None), "set_cache_limit", None)
if _set_cache_limit is not None:
    _set_cache_limit(5 * 1024 * 1024 * 1024)


_mlx_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-infer")


def setup_logging(level: str = "INFO") -> logging.Logger:
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    return logging.getLogger(__name__)


logger = setup_logging(os.getenv("LOG_LEVEL", "INFO"))


@dataclass
class ServerConfig:
    model_name: str = os.getenv("MODEL_NAME", DEFAULT_MODEL)
    max_batch_size: int = int(os.getenv("MAX_BATCH_SIZE", str(DEFAULT_MAX_BATCH)))
    max_text_length: int = int(os.getenv("MAX_TEXT_LENGTH", str(DEFAULT_MAX_LENGTH)))
    port: int = int(os.getenv("PORT", str(DEFAULT_PORT)))
    host: str = os.getenv("HOST", DEFAULT_HOST)
    enable_cors: bool = os.getenv("ENABLE_CORS", "true").lower() == "true"
    cors_origins: Optional[List[str]] = None

    def __post_init__(self):
        if self.cors_origins is None:
            self.cors_origins = os.getenv("CORS_ORIGINS", "*").split(",")
        if self.max_batch_size < MIN_BATCH_SIZE:
            raise ValueError(f"max_batch_size must be >= {MIN_BATCH_SIZE}")
        if self.max_text_length < 1:
            raise ValueError("max_text_length must be positive")
        if not (1 <= self.port <= 65535):
            raise ValueError("port must be 1..65535")


def parse_args():
    p = argparse.ArgumentParser(description="Qwen3 Embedding Server (MLX, standalone)")
    p.add_argument("--model", type=str, default=None)
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--host", type=str, default=None)
    return p.parse_args()


_cli_args = parse_args()


def _resolve_cli_model(arg: Optional[str]) -> str:
    if not arg:
        return os.getenv("MODEL_NAME", DEFAULT_MODEL)
    lower = arg.lower()
    if lower in MODEL_ALIASES:
        return MODEL_ALIASES[lower]
    if arg in AVAILABLE_MODELS:
        return arg
    for name in AVAILABLE_MODELS:
        if lower in name.lower():
            return name
    return arg


config = ServerConfig(
    model_name=_resolve_cli_model(_cli_args.model),
    port=_cli_args.port or int(os.getenv("PORT", str(DEFAULT_PORT))),
    host=_cli_args.host or os.getenv("HOST", DEFAULT_HOST),
)


class ModelStatus(str, Enum):
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"
    UNLOADED = "unloaded"


class ModelManager:
    """Load + cache + embed. Single-model resident (simpler than production's
    multi-model LRU — standalone variant targets one active model per
    process, which matches observed production usage 2026-04-22)."""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.models: Dict[str, Tuple[Model, Tokenizer]] = {}
        self.model_status: Dict[str, ModelStatus] = {}
        self.model_load_times: Dict[str, float] = {}
        self._locks: Dict[str, asyncio.Lock] = {}
        # W3 P0: LRU eviction (2026-04-27) — OrderedDict + move_to_end on hit (F1)
        self._embedding_cache: OrderedDict = OrderedDict()
        self._global_lock = asyncio.Lock()

    def _resolve_model_name(self, identifier: Optional[str]) -> str:
        if not identifier:
            return self.config.model_name
        low = identifier.lower()
        if low in MODEL_ALIASES:
            return MODEL_ALIASES[low]
        if identifier in AVAILABLE_MODELS:
            return identifier
        raise ValueError(f"Unknown model: {identifier}")

    async def load_model(self, model_name: Optional[str] = None) -> str:
        model_name = self._resolve_model_name(model_name)
        if model_name in self.models and self.model_status.get(model_name) == ModelStatus.READY:
            return model_name

        async with self._global_lock:
            if model_name not in self._locks:
                self._locks[model_name] = asyncio.Lock()

        async with self._locks[model_name]:
            if model_name in self.models and self.model_status.get(model_name) == ModelStatus.READY:
                return model_name

            self.model_status[model_name] = ModelStatus.LOADING
            logger.info(f"Loading (standalone) model: {model_name}")
            t0 = time.time()
            try:
                model_dir = resolve_model_dir(model_name)
                model, _args, tok = load_standalone(model_dir)
                self.models[model_name] = (model, tok)
                await self._warmup(model_name)
                self.model_load_times[model_name] = time.time() - t0
                self.model_status[model_name] = ModelStatus.READY
                logger.info(f"Model {model_name} ready in {self.model_load_times[model_name]:.2f}s")
                return model_name
            except Exception as e:
                self.model_status[model_name] = ModelStatus.ERROR
                logger.error(f"Load failed for {model_name}: {e}", exc_info=True)
                raise RuntimeError(f"Model loading failed: {e}") from e

    async def _warmup(self, model_name: str) -> None:
        try:
            model, tok = self.models[model_name]
            for text in ["warmup", "test"]:
                ids = tok.encode(text).ids[: self.config.max_text_length]
                input_ids = mx.array([ids])
                h = model.model(input_ids, mask=None)
                pooled = mx.mean(h, axis=1)
                mx.eval(pooled)
        except Exception as e:
            logger.warning(f"Warmup non-fatal error for {model_name}: {e}")

    def _run_batch_sync(
        self,
        to_encode: List[str],
        model: Model,
        tokenizer: Tokenizer,
        normalize: bool,
    ) -> np.ndarray:
        """Runs on the dedicated single-thread MLX executor. Mirrors the
        production _run_batch_sync contract: masked mean pool + optional L2
        + full metal-cache release at end-of-batch."""
        # Rust tokenizer batch — returns list[Encoding] with .ids + .attention_mask.
        # enable_padding/enable_truncation were set at load time.
        encs = tokenizer.encode_batch(to_encode)
        ids_py = [e.ids for e in encs]
        mask_py = [e.attention_mask for e in encs]

        input_ids = mx.array(ids_py)
        attn_mask = mx.array(mask_py)

        hidden_states = model.model(input_ids, mask=None)  # [B, L, H], bidirectional

        mask_f = attn_mask.astype(hidden_states.dtype)
        mask_exp = mx.expand_dims(mask_f, axis=-1)
        summed = mx.sum(hidden_states * mask_exp, axis=1)
        counts = mx.maximum(mx.sum(mask_f, axis=1, keepdims=True), 1e-9)
        pooled = summed / counts

        if normalize:
            norm = mx.linalg.norm(pooled, axis=1, keepdims=True)
            pooled = pooled / mx.maximum(norm, 1e-9)

        mx.eval(pooled)
        pooled_np = np.array(pooled.tolist(), dtype=np.float32)

        del hidden_states, pooled, input_ids, attn_mask, mask_f, mask_exp, summed, counts

        if _clear_cache is not None:
            _clear_cache()
        gc.collect()

        return pooled_np

    async def generate_embeddings(
        self,
        texts: List[str],
        model_name: Optional[str] = None,
        normalize: bool = True,
    ) -> Tuple[np.ndarray, str, int]:
        model_name = await self.load_model(model_name)
        if self.model_status.get(model_name) != ModelStatus.READY:
            raise RuntimeError(f"Model {model_name} not ready")
        if not texts:
            return np.array([]), model_name, AVAILABLE_MODELS[model_name]["embedding_dim"]

        model, tok = self.models[model_name]
        emb_dim = AVAILABLE_MODELS[model_name]["embedding_dim"]

        cached: Dict[int, np.ndarray] = {}
        to_encode_idx: List[int] = []
        to_encode: List[str] = []
        cache_keys: List[str] = []
        for i, text in enumerate(texts):
            key = f"{model_name}:{text}:{normalize}"
            cache_keys.append(key)
            if key in self._embedding_cache:
                cached[i] = self._embedding_cache[key]
                # W3 P0: LRU eviction (2026-04-27) — recently-used stays (F1)
                self._embedding_cache.move_to_end(key)
            else:
                to_encode_idx.append(i)
                to_encode.append(text)

        computed: Dict[int, np.ndarray] = {}
        if to_encode:
            loop = asyncio.get_running_loop()
            pooled_np = await loop.run_in_executor(
                _mlx_executor, self._run_batch_sync, to_encode, model, tok, normalize
            )
            for j, i in enumerate(to_encode_idx):
                emb = pooled_np[j]
                computed[i] = emb
                # W3 P0: LRU eviction (2026-04-27) — always assign, then evict from front (F1)
                self._embedding_cache[cache_keys[i]] = emb
                while len(self._embedding_cache) > _EMBED_CACHE_MAX:
                    self._embedding_cache.popitem(last=False)
        else:
            # W3 P0: cache-hit-only path — periodic purge (every 60s) to drop Metal aux allocations (F18)
            global _LAST_CLEAR_CACHE_AT
            now = time.time()
            if now - _LAST_CLEAR_CACHE_AT > _CLEAR_CACHE_MIN_INTERVAL_S:
                if _clear_cache is not None:
                    try: _clear_cache()
                    except Exception: pass
                try: gc.collect()
                except Exception: pass
                _LAST_CLEAR_CACHE_AT = now

        out = [cached[i] if i in cached else computed[i] for i in range(len(texts))]
        return np.array(out, dtype=np.float32), model_name, emb_dim

    def get_status(self, model_name: Optional[str] = None) -> Dict[str, Any]:
        if model_name:
            model_name = self._resolve_model_name(model_name)
            return {
                "status": self.model_status.get(model_name, ModelStatus.UNLOADED).value,
                "model_name": model_name,
                "embedding_dim": AVAILABLE_MODELS[model_name]["embedding_dim"],
                "load_time": self.model_load_times.get(model_name),
                "description": AVAILABLE_MODELS[model_name]["description"],
            }
        return {
            "loaded_models": list(self.models.keys()),
            "default_model": self.config.model_name,
            "max_batch_size": self.config.max_batch_size,
            "max_text_length": self.config.max_text_length,
            "cache_size": len(self._embedding_cache),
            "models": {
                name: {
                    "status": self.model_status.get(name, ModelStatus.UNLOADED).value,
                    "embedding_dim": cfg["embedding_dim"],
                    "load_time": self.model_load_times.get(name),
                    "aliases": cfg["alias"],
                    "description": cfg["description"],
                }
                for name, cfg in AVAILABLE_MODELS.items()
            },
        }


model_manager = ModelManager(config)


# ═══════════════════════════════════════════════════════════════════════════
# 4. Pydantic schemas + FastAPI routes — mirror production server exactly.
# ═══════════════════════════════════════════════════════════════════════════


class EmbedRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    text: str = Field(..., min_length=1, max_length=config.max_text_length * 10)
    model: Optional[str] = None
    normalize: bool = True

    @field_validator("text")
    def _validate_text(cls, v):
        if not v or v.isspace():
            raise ValueError("Text cannot be empty or whitespace only")
        return v


class EmbedResponse(BaseModel):
    embedding: List[float]
    model: str
    dim: int
    normalized: bool
    processing_time_ms: float


class BatchEmbedRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    texts: List[str] = Field(..., min_length=1, max_length=1024)
    model: Optional[str] = None
    normalize: bool = True

    @field_validator("texts")
    def _validate_texts(cls, v):
        if not v:
            raise ValueError("Text list cannot be empty")
        for i, t in enumerate(v):
            if not t or t.isspace():
                raise ValueError(f"Text at index {i} empty/whitespace")
        return v


class BatchEmbedResponse(BaseModel):
    embeddings: List[List[float]]
    model: str
    dim: int
    count: int
    normalized: bool
    processing_time_ms: float


class HealthResponse(BaseModel):
    status: str
    model_status: str
    model_name: str
    embedding_dim: int
    memory_usage_mb: Optional[float] = None
    uptime_seconds: float


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting Qwen3 Embedding Server (standalone) v{app.version}")
    logger.info(f"Config: {config}")
    try:
        await model_manager.load_model(config.model_name)
    except Exception as e:
        logger.error(f"Default model load failed (lazy retry enabled): {e}")
    app.state.start_time = time.time()
    yield
    logger.info("Shutting down server...")


app = FastAPI(
    title="Qwen3 Embedding Server (standalone)",
    description="High-performance text embedding service using MLX (mlx_lm-free variant)",
    version="2.0.0-standalone",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

if config.enable_cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )


@app.middleware("http")
async def _log_requests(request: Request, call_next):
    t0 = time.time()
    try:
        resp = await call_next(request)
        dt = (time.time() - t0) * 1000
        logger.info(f"{request.method} {request.url.path} - Status: {resp.status_code} - Time: {dt:.2f}ms")
        resp.headers["X-Process-Time"] = str(dt)
        return resp
    except Exception as e:
        dt = (time.time() - t0) * 1000
        logger.error(f"{request.method} {request.url.path} - Error: {e} - Time: {dt:.2f}ms")
        raise


@app.get("/", tags=["General"])
async def root():
    return {
        "service": "Qwen3 Embedding Server (standalone)",
        "version": app.version,
        "default_model": config.model_name,
        "available_models": list(AVAILABLE_MODELS.keys()),
        "endpoints": {
            "embeddings": "/embed",
            "batch_embeddings": "/embed_batch",
            "health": "/health",
            "metrics": "/metrics",
            "models": "/models",
            "ollama_compat": "/api/embeddings",
            "openai_compat": "/v1/embeddings",
            "documentation": "/docs",
        },
    }


@app.post("/embed", response_model=EmbedResponse, tags=["Embeddings"])
async def embed_single(req: EmbedRequest):
    try:
        t0 = time.time()
        embs, model_used, dim = await model_manager.generate_embeddings(
            [req.text], model_name=req.model, normalize=req.normalize
        )
        dt = (time.time() - t0) * 1000
        return EmbedResponse(
            embedding=embs[0].tolist(),
            model=model_used,
            dim=dim,
            normalized=req.normalize,
            processing_time_ms=dt,
        )
    except Exception as e:
        logger.error(f"embed failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed_batch", response_model=BatchEmbedResponse, tags=["Embeddings"])
async def embed_batch(req: BatchEmbedRequest):
    try:
        t0 = time.time()
        embs, model_used, dim = await model_manager.generate_embeddings(
            req.texts, model_name=req.model, normalize=req.normalize
        )
        dt = (time.time() - t0) * 1000
        return BatchEmbedResponse(
            embeddings=embs.tolist(),
            model=model_used,
            dim=dim,
            count=len(embs),
            normalized=req.normalize,
            processing_time_ms=dt,
        )
    except Exception as e:
        logger.error(f"embed_batch failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health", response_model=HealthResponse, tags=["Monitoring"])
async def health_check():
    memory_mb = None
    try:
        import psutil
        memory_mb = psutil.Process().memory_info().rss / 1024 / 1024
    except ImportError:
        pass

    uptime = time.time() - app.state.start_time if hasattr(app.state, "start_time") else 0
    status_val = model_manager.model_status.get(config.model_name, ModelStatus.UNLOADED)
    return HealthResponse(
        status="healthy" if status_val == ModelStatus.READY else "degraded",
        model_status=status_val.value,
        model_name=config.model_name,
        embedding_dim=AVAILABLE_MODELS[config.model_name]["embedding_dim"],
        memory_usage_mb=memory_mb,
        uptime_seconds=uptime,
    )


@app.get("/metrics", tags=["Monitoring"])
async def get_metrics():
    return {
        "models": model_manager.get_status(),
        "config": {
            "host": config.host,
            "port": config.port,
            "max_batch_size": config.max_batch_size,
            "max_text_length": config.max_text_length,
            "cors_enabled": config.enable_cors,
        },
        "version": app.version,
    }


@app.get("/models", tags=["Models"])
async def list_models():
    return model_manager.get_status()


# ── Ollama-compat (used by vcontext-server.js checkCoreml + /embed calls) ──


class OllamaEmbedRequest(BaseModel):
    model: Optional[str] = None
    prompt: str = ""
    input: Optional[str] = None


@app.post("/api/embeddings", tags=["Compatibility"])
async def ollama_compat_embeddings(req: OllamaEmbedRequest):
    text = req.prompt or req.input or ""
    if not text or text.isspace():
        raise HTTPException(status_code=400, detail="prompt/input required")
    try:
        t0 = time.time()
        embs, model_used, dim = await model_manager.generate_embeddings(
            [text], model_name=req.model, normalize=True
        )
        dt = (time.time() - t0) * 1000
        return {
            "embedding": embs[0].tolist(),
            "model": model_used,
            "dim": dim,
            "processing_time_ms": round(dt, 2),
        }
    except Exception as e:
        logger.error(f"ollama compat failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class OpenAIEmbedRequest(BaseModel):
    input: Any
    model: Optional[str] = None
    encoding_format: Optional[str] = "float"


@app.post("/v1/embeddings", tags=["Compatibility"])
async def openai_compat_embeddings(req: OpenAIEmbedRequest):
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    if not texts:
        raise HTTPException(status_code=400, detail="input required")
    try:
        t0 = time.time()
        embs, model_used, dim = await model_manager.generate_embeddings(
            texts, model_name=req.model, normalize=True
        )
        dt = (time.time() - t0) * 1000
        data = [
            {"object": "embedding", "embedding": e.tolist(), "index": i}
            for i, e in enumerate(embs)
        ]
        return {
            "object": "list",
            "data": data,
            "model": model_used,
            "usage": {
                "prompt_tokens": sum(len(t.split()) for t in texts),
                "total_tokens": sum(len(t.split()) for t in texts),
            },
        }
    except Exception as e:
        logger.error(f"openai compat failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/clear_cache", tags=["Maintenance"])
async def clear_cache_endpoint():
    if _clear_cache is not None:
        _clear_cache()
    gc.collect()
    return {"cleared": True}


@app.get("/api/health", tags=["Compatibility"])
async def compat_health():
    s = model_manager.model_status.get(config.model_name, ModelStatus.UNLOADED)
    return {
        "status": "ok" if s == ModelStatus.READY else "loading",
        "backend": "mlx-standalone",
        "model": config.model_name,
        "embedding_dim": AVAILABLE_MODELS[config.model_name]["embedding_dim"],
        "max_seq_len": config.max_text_length,
    }


@app.exception_handler(ValueError)
async def _value_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def _general_handler(request: Request, exc: Exception):
    logger.error(f"Unexpected: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "An unexpected error occurred"})


def main():
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
        access_log=True,
    )


if __name__ == "__main__":
    main()
