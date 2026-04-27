#!/usr/bin/env python3
"""
Cross-platform NPU-accelerated embedding server for BGE-small-en-v1.5.

Platform detection and backend selection:
  macOS   -> CoreML with Apple Neural Engine (NPU)
  Windows -> ONNX Runtime with DirectML (Windows NPU)
  Any     -> CPU fallback (numpy-based ONNX Runtime)

Serves a simple HTTP API compatible with vcontext-server.js embedding calls.

Usage:
  python3 coreml-embed-server.py                     # auto-detect backend
  python3 coreml-embed-server.py --backend coreml    # force CoreML
  python3 coreml-embed-server.py --backend onnx-dml  # force ONNX+DirectML
  python3 coreml-embed-server.py --backend onnx-cpu  # force ONNX CPU

Port: 3161 (within Claude Code 3000-3499 range, same project as vcontext 3150)

Model: BAAI/bge-small-en-v1.5 (384-dim embeddings, ~33M params)
  - CoreML:  /Volumes/VContext/bge-small-coreml.mlpackage (converted with CLS pooling + L2 norm)
  - ONNX:   models/bge-small-en-v1.5.onnx

Export models first:
  python3 coreml-embed-server.py --export
"""

import argparse
import json
import os
import platform
import signal
import sys
import time
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler  # W3 P0: ThreadingHTTPServer for concurrent /embed (F5, 2026-04-27)
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384
MAX_SEQ_LEN = 128  # our CoreML model was converted with seq_len=128 (sufficient for queries)
DEFAULT_PORT = int(os.environ.get("EMBED_PORT", "3161"))
MODEL_DIR = Path(__file__).parent.parent / "models"
COREML_PATH = Path("/Volumes/VContext/bge-small-coreml.mlpackage")
ONNX_PATH = MODEL_DIR / "bge-small-en-v1.5.onnx"

# BGE instruction prefix for query embedding (improves retrieval quality)
BGE_QUERY_PREFIX = "Represent this sentence: "

# ---------------------------------------------------------------------------
# Backend: abstract base
# ---------------------------------------------------------------------------
class EmbedBackend:
    """Abstract embedding backend."""
    name = "base"

    def load(self):
        raise NotImplementedError

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError

    def unload(self):
        pass


# ---------------------------------------------------------------------------
# Backend: CoreML (macOS with Apple Neural Engine)
# ---------------------------------------------------------------------------
class CoreMLBackend(EmbedBackend):
    name = "coreml"

    def __init__(self):
        self.model = None
        self.tokenizer = None

    def load(self):
        import coremltools as ct
        from transformers import AutoTokenizer

        if not COREML_PATH.exists():
            raise FileNotFoundError(
                f"CoreML model not found at {COREML_PATH}. "
                f"Run: python3 convert-bge-coreml.py"
            )

        print(f"[coreml] Loading tokenizer: {MODEL_NAME}")
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

        print(f"[coreml] Loading CoreML model from {COREML_PATH} ...")
        # Prefer Neural Engine, fall back to CPU+GPU
        self.model = ct.models.MLModel(
            str(COREML_PATH),
            compute_units=ct.ComputeUnit.ALL,  # ANE > GPU > CPU
        )
        print("[coreml] Model loaded (compute_units=ALL, ANE preferred)")

        # Warmup — first inference compiles for Neural Engine
        print("[coreml] Warming up (first inference compiles for ANE)...")
        t0 = time.time()
        self.embed(["warmup"])
        warmup_ms = (time.time() - t0) * 1000
        print(f"[coreml] Warmup: {warmup_ms:.0f}ms")

        t0 = time.time()
        self.embed(["speed test query"])
        speed_ms = (time.time() - t0) * 1000
        print(f"[coreml] Inference speed: {speed_ms:.1f}ms")

    def embed(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        results = []
        for text in texts:
            # BGE recommends prefixing queries for better retrieval
            prefixed = BGE_QUERY_PREFIX + text

            tokens = self.tokenizer(
                prefixed,
                padding="max_length",
                truncation=True,
                max_length=MAX_SEQ_LEN,
                return_tensors="np",
            )

            # Our converted model expects input_ids, attention_mask, token_type_ids
            # and outputs a pre-pooled, L2-normalized 384-dim embedding directly
            prediction = self.model.predict({
                "input_ids": tokens["input_ids"].astype(np.int32),
                "attention_mask": tokens["attention_mask"].astype(np.int32),
                "token_type_ids": tokens.get(
                    "token_type_ids",
                    np.zeros_like(tokens["input_ids"]),
                ).astype(np.int32),
            })

            # Model output is named "embedding" — already CLS-pooled and L2-normalized
            embedding = np.array(prediction["embedding"]).flatten()
            results.append(embedding.tolist())

        return results


# ---------------------------------------------------------------------------
# Backend: ONNX Runtime + DirectML (Windows NPU/GPU)
# ---------------------------------------------------------------------------
class OnnxDirectMLBackend(EmbedBackend):
    name = "onnx-dml"

    def __init__(self):
        self.session = None
        self.tokenizer = None

    def load(self):
        import onnxruntime as ort
        from transformers import AutoTokenizer

        if not ONNX_PATH.exists():
            raise FileNotFoundError(
                f"ONNX model not found at {ONNX_PATH}. "
                f"Run: python3 {__file__} --export"
            )

        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

        # DirectML provider for Windows NPU/GPU acceleration
        providers = []
        available = ort.get_available_providers()
        if "DmlExecutionProvider" in available:
            providers.append("DmlExecutionProvider")
            print("[onnx-dml] DirectML provider available (NPU/GPU acceleration)")
        else:
            print("[onnx-dml] DirectML not available, falling back to CPU")

        providers.append("CPUExecutionProvider")  # always include CPU fallback

        print(f"[onnx-dml] Loading model from {ONNX_PATH} ...")
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            str(ONNX_PATH),
            sess_options=sess_options,
            providers=providers,
        )
        active = self.session.get_providers()
        print(f"[onnx-dml] Model loaded (active providers: {active})")

    def embed(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        results = []
        for text in texts:
            prefixed = BGE_QUERY_PREFIX + text
            tokens = self.tokenizer(
                prefixed,
                padding="max_length",
                truncation=True,
                max_length=MAX_SEQ_LEN,
                return_tensors="np",
            )

            feeds = {
                "input_ids": tokens["input_ids"].astype(np.int64),
                "attention_mask": tokens["attention_mask"].astype(np.int64),
            }

            # Add token_type_ids if the model expects it
            input_names = [inp.name for inp in self.session.get_inputs()]
            if "token_type_ids" in input_names:
                feeds["token_type_ids"] = tokens.get(
                    "token_type_ids",
                    np.zeros_like(tokens["input_ids"]),
                ).astype(np.int64)

            outputs = self.session.run(None, feeds)

            # outputs[0] is typically last_hidden_state: (1, seq_len, hidden_dim)
            hidden = outputs[0]

            # Mean pooling
            mask = tokens["attention_mask"].astype(np.float32)
            if hidden.ndim == 3:
                mask_expanded = np.expand_dims(mask, -1)
                summed = np.sum(hidden * mask_expanded, axis=1)
                counts = np.sum(mask_expanded, axis=1).clip(min=1e-9)
                pooled = (summed / counts)[0]
            elif hidden.ndim == 2 and hidden.shape[-1] == EMBED_DIM:
                pooled = hidden[0]
            else:
                pooled = hidden.flatten()[:EMBED_DIM]

            # L2 normalize
            norm = np.linalg.norm(pooled)
            if norm > 0:
                pooled = pooled / norm

            results.append(pooled.tolist())

        return results


# ---------------------------------------------------------------------------
# Backend: ONNX Runtime CPU-only (any platform fallback)
# ---------------------------------------------------------------------------
class OnnxCpuBackend(EmbedBackend):
    name = "onnx-cpu"

    def __init__(self):
        self.session = None
        self.tokenizer = None

    def load(self):
        import onnxruntime as ort
        from transformers import AutoTokenizer

        if not ONNX_PATH.exists():
            raise FileNotFoundError(
                f"ONNX model not found at {ONNX_PATH}. "
                f"Run: python3 {__file__} --export"
            )

        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

        print(f"[onnx-cpu] Loading model from {ONNX_PATH} ...")
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.intra_op_num_threads = os.cpu_count() or 4
        self.session = ort.InferenceSession(
            str(ONNX_PATH),
            sess_options=sess_options,
            providers=["CPUExecutionProvider"],
        )
        print("[onnx-cpu] Model loaded (CPU only)")

    def embed(self, texts: list[str]) -> list[list[float]]:
        import numpy as np

        results = []
        for text in texts:
            prefixed = BGE_QUERY_PREFIX + text
            tokens = self.tokenizer(
                prefixed,
                padding="max_length",
                truncation=True,
                max_length=MAX_SEQ_LEN,
                return_tensors="np",
            )

            feeds = {
                "input_ids": tokens["input_ids"].astype(np.int64),
                "attention_mask": tokens["attention_mask"].astype(np.int64),
            }

            input_names = [inp.name for inp in self.session.get_inputs()]
            if "token_type_ids" in input_names:
                feeds["token_type_ids"] = tokens.get(
                    "token_type_ids",
                    np.zeros_like(tokens["input_ids"]),
                ).astype(np.int64)

            outputs = self.session.run(None, feeds)
            hidden = outputs[0]

            mask = tokens["attention_mask"].astype(np.float32)
            if hidden.ndim == 3:
                mask_expanded = np.expand_dims(mask, -1)
                summed = np.sum(hidden * mask_expanded, axis=1)
                counts = np.sum(mask_expanded, axis=1).clip(min=1e-9)
                pooled = (summed / counts)[0]
            elif hidden.ndim == 2 and hidden.shape[-1] == EMBED_DIM:
                pooled = hidden[0]
            else:
                pooled = hidden.flatten()[:EMBED_DIM]

            norm = np.linalg.norm(pooled)
            if norm > 0:
                pooled = pooled / norm

            results.append(pooled.tolist())

        return results


# ---------------------------------------------------------------------------
# Model export: CoreML + ONNX from the same HuggingFace checkpoint
# ---------------------------------------------------------------------------
def export_models():
    """Export BGE-small-en-v1.5 to both CoreML (.mlpackage) and ONNX (.onnx)."""
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[export] Downloading {MODEL_NAME} from HuggingFace ...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME)
    model.eval()

    # Dummy input for tracing
    dummy_text = "This is a test sentence for model export."
    tokens = tokenizer(
        dummy_text,
        padding="max_length",
        truncation=True,
        max_length=MAX_SEQ_LEN,
        return_tensors="pt",
    )
    dummy_input_ids = tokens["input_ids"]
    dummy_attention_mask = tokens["attention_mask"]

    # ── ONNX export ──────────────────────────────────────────────
    if not ONNX_PATH.exists():
        print(f"[export] Exporting ONNX to {ONNX_PATH} ...")
        torch.onnx.export(
            model,
            (dummy_input_ids, dummy_attention_mask),
            str(ONNX_PATH),
            input_names=["input_ids", "attention_mask"],
            output_names=["last_hidden_state"],
            dynamic_axes={
                "input_ids": {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "last_hidden_state": {0: "batch", 1: "seq"},
            },
            opset_version=14,
            do_constant_folding=True,
        )
        print(f"[export] ONNX saved: {ONNX_PATH} ({ONNX_PATH.stat().st_size / 1e6:.1f} MB)")
    else:
        print(f"[export] ONNX already exists: {ONNX_PATH}")

    # ── CoreML export (macOS only) ───────────────────────────────
    if platform.system() == "Darwin":
        if not COREML_PATH.exists():
            print(f"[export] Exporting CoreML to {COREML_PATH} ...")
            try:
                import coremltools as ct

                # Trace the model
                traced = torch.jit.trace(
                    model,
                    (dummy_input_ids, dummy_attention_mask),
                )

                # Convert to CoreML
                mlmodel = ct.convert(
                    traced,
                    inputs=[
                        ct.TensorType(
                            name="input_ids",
                            shape=(1, MAX_SEQ_LEN),
                            dtype=np.int32,
                        ),
                        ct.TensorType(
                            name="attention_mask",
                            shape=(1, MAX_SEQ_LEN),
                            dtype=np.int32,
                        ),
                    ],
                    compute_units=ct.ComputeUnit.ALL,
                    minimum_deployment_target=ct.target.macOS13,
                )
                mlmodel.save(str(COREML_PATH))
                print(f"[export] CoreML saved: {COREML_PATH}")
            except ImportError:
                print("[export] coremltools not installed, skipping CoreML export")
                print("[export] Install with: pip install coremltools")
            except Exception as e:
                print(f"[export] CoreML export failed: {e}")
                print("[export] ONNX model is still available for CPU/DirectML")
        else:
            print(f"[export] CoreML already exists: {COREML_PATH}")
    else:
        print("[export] Skipping CoreML export (macOS only)")

    print("[export] Done. Models ready in:", MODEL_DIR)


# ---------------------------------------------------------------------------
# Auto-detect the best backend for the current platform
# ---------------------------------------------------------------------------
def detect_backend(force: str | None = None) -> EmbedBackend:
    """
    Detect and return the best available backend.

    Priority:
      1. Forced backend (--backend flag)
      2. macOS -> CoreML (ANE)
      3. Windows -> ONNX + DirectML (NPU)
      4. Any -> ONNX CPU
    """
    if force:
        backends = {
            "coreml": CoreMLBackend,
            "onnx-dml": OnnxDirectMLBackend,
            "onnx-cpu": OnnxCpuBackend,
        }
        if force not in backends:
            print(f"[detect] Unknown backend '{force}'. Options: {list(backends.keys())}")
            sys.exit(1)
        return backends[force]()

    system = platform.system()

    # macOS: try CoreML first
    if system == "Darwin":
        if COREML_PATH.exists():
            try:
                import coremltools  # noqa: F401
                print("[detect] macOS detected, CoreML model found -> using CoreML (ANE)")
                return CoreMLBackend()
            except ImportError:
                print("[detect] macOS but coremltools not installed, trying ONNX")
        else:
            print(f"[detect] macOS but no CoreML model at {COREML_PATH}")

    # Windows: try ONNX + DirectML
    if system == "Windows":
        if ONNX_PATH.exists():
            try:
                import onnxruntime as ort
                if "DmlExecutionProvider" in ort.get_available_providers():
                    print("[detect] Windows + DirectML available -> using ONNX+DirectML (NPU)")
                    return OnnxDirectMLBackend()
                else:
                    print("[detect] Windows but no DirectML, falling back to ONNX CPU")
            except ImportError:
                print("[detect] onnxruntime not installed")
        else:
            print(f"[detect] Windows but no ONNX model at {ONNX_PATH}")

    # Fallback: ONNX CPU (any platform)
    if ONNX_PATH.exists():
        try:
            import onnxruntime  # noqa: F401
            print("[detect] Falling back to ONNX CPU")
            return OnnxCpuBackend()
        except ImportError:
            pass

    print("[detect] No backend available. Export models first:")
    print(f"  python3 {__file__} --export")
    print("")
    print("Required packages:")
    print("  macOS:   pip install coremltools transformers torch numpy")
    print("  Windows: pip install onnxruntime-directml transformers torch numpy")
    print("  CPU:     pip install onnxruntime transformers torch numpy")
    sys.exit(1)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
class EmbedHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the embedding server."""

    backend: EmbedBackend = None  # set at class level before serving
    request_count: int = 0
    start_time: float = 0

    def log_message(self, format, *args):
        """Suppress default access logs; we log our own."""
        pass

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/health" or path == "/":
            self._handle_health()
        elif path == "/embed":
            # GET /embed?text=...
            params = parse_qs(parsed.query)
            text = params.get("text", [None])[0]
            if not text:
                self._send_json(400, {"error": "Missing 'text' query parameter"})
                return
            self._handle_embed([text])
        else:
            self._send_json(404, {"error": "Not found", "endpoints": [
                "GET  /health",
                "GET  /embed?text=...",
                "POST /embed  {\"text\": \"...\"} or {\"texts\": [...]}",
                "POST /embeddings  (Ollama-compatible: {\"model\": \"...\", \"prompt\": \"...\"})",
            ]})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        # Read body
        length = int(self.headers.get("Content-Length", 0))
        if length > 1_000_000:  # 1MB limit
            self._send_json(413, {"error": "Request too large"})
            return
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
            return

        if path == "/embed":
            # POST /embed {"text": "single"} or {"texts": ["batch", ...]}
            texts = body.get("texts") or ([body["text"]] if "text" in body else None)
            if not texts:
                self._send_json(400, {"error": "Provide 'text' (string) or 'texts' (array)"})
                return
            self._handle_embed(texts)

        elif path == "/embeddings":
            # Ollama-compatible: POST /embeddings {"model": "...", "prompt": "..."}
            # Also accept /api/embeddings for full compatibility
            prompt = body.get("prompt") or body.get("input", "")
            if not prompt:
                self._send_json(400, {"error": "Missing 'prompt' field"})
                return
            self._handle_embed_ollama(prompt)

        elif path == "/api/embeddings":
            # Ollama API path
            prompt = body.get("prompt") or body.get("input", "")
            if not prompt:
                self._send_json(400, {"error": "Missing 'prompt' field"})
                return
            self._handle_embed_ollama(prompt)

        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_health(self):
        EmbedHandler.request_count += 0  # just for tracking
        uptime = time.time() - EmbedHandler.start_time if EmbedHandler.start_time else 0
        self._send_json(200, {
            "status": "ok",
            "backend": EmbedHandler.backend.name if EmbedHandler.backend else "none",
            "model": MODEL_NAME,
            "embedding_dim": EMBED_DIM,
            "max_seq_len": MAX_SEQ_LEN,
            "platform": platform.system(),
            "uptime_seconds": round(uptime, 1),
            "requests_served": EmbedHandler.request_count,
        })

    def _handle_embed(self, texts: list[str]):
        """Handle /embed endpoint -- returns list of embeddings."""
        if not EmbedHandler.backend:
            self._send_json(503, {"error": "Backend not loaded"})
            return

        t0 = time.time()
        try:
            embeddings = EmbedHandler.backend.embed(texts)
        except Exception as e:
            self._send_json(500, {"error": f"Embedding failed: {str(e)}"})
            return
        elapsed_ms = round((time.time() - t0) * 1000, 1)

        EmbedHandler.request_count += 1
        print(f"[embed] {len(texts)} text(s), {elapsed_ms}ms, backend={EmbedHandler.backend.name}")

        self._send_json(200, {
            "embeddings": embeddings,
            "model": MODEL_NAME,
            "backend": EmbedHandler.backend.name,
            "dim": EMBED_DIM,
            "count": len(embeddings),
            "elapsed_ms": elapsed_ms,
        })

    def _handle_embed_ollama(self, prompt: str):
        """Handle /embeddings (Ollama-compatible) -- returns single embedding."""
        if not EmbedHandler.backend:
            self._send_json(503, {"error": "Backend not loaded"})
            return

        t0 = time.time()
        try:
            embeddings = EmbedHandler.backend.embed([prompt])
        except Exception as e:
            self._send_json(500, {"error": f"Embedding failed: {str(e)}"})
            return
        elapsed_ms = round((time.time() - t0) * 1000, 1)

        EmbedHandler.request_count += 1
        print(f"[embed] ollama-compat, {elapsed_ms}ms, backend={EmbedHandler.backend.name}")

        # Ollama-compatible response format
        self._send_json(200, {
            "embedding": embeddings[0] if embeddings else [],
        })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Cross-platform NPU embedding server (BGE-small-en-v1.5)",
    )
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT,
        help=f"HTTP port (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--backend", type=str, default=None,
        choices=["coreml", "onnx-dml", "onnx-cpu"],
        help="Force a specific backend (default: auto-detect)",
    )
    parser.add_argument(
        "--export", action="store_true",
        help="Export model to CoreML + ONNX formats, then exit",
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Bind address (default: 127.0.0.1)",
    )
    args = parser.parse_args()

    # Export mode
    if args.export:
        export_models()
        return

    # Detect and load backend
    backend = detect_backend(args.backend)
    try:
        backend.load()
    except FileNotFoundError as e:
        print(f"[error] {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[error] Failed to load backend '{backend.name}': {e}")
        sys.exit(1)

    # Configure handler
    EmbedHandler.backend = backend
    EmbedHandler.start_time = time.time()

    # Port check — auto-find available port if default is taken
    import socket
    # W3 P0: refuse to rebind into AIOS reserved port (F5)
    RESERVED_AIOS_PORTS = {3162, 3163, 3150, 3160, 8888}  # mlx-generate-proxy, mlx-generate-backup, vcontext, mlx-embed-coreml-fallback, searxng
    port = args.port
    for attempt in range(10):
        # W3 P0: refuse to rebind into AIOS reserved port (F5)
        if port in RESERVED_AIOS_PORTS and port != args.port:
            print(f"[server] Port {port} reserved for another AIOS service, skipping")
            port += 1
            continue
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind((args.host, port))
            sock.close()
            break
        except OSError:
            sock.close()
            print(f"[server] Port {port} in use, trying {port + 1}")
            port += 1
    else:
        print(f"[error] No available port found ({args.port}-{port})")
        sys.exit(1)

    # Start server
    server = ThreadingHTTPServer((args.host, port), EmbedHandler)  # W3 P0: ThreadingHTTPServer for concurrent /embed (F5, 2026-04-27)
    print(f"[server] Embedding server running on http://{args.host}:{port}")  # W3 P0: log actual bound port not args (F5)
    print(f"[server] Backend: {backend.name} | Model: {MODEL_NAME} | Dim: {EMBED_DIM}")
    print(f"[server] Platform: {platform.system()} {platform.machine()}")
    print(f"[server] Endpoints:")
    print(f"  GET  /health")
    print(f"  GET  /embed?text=...")
    print(f"  POST /embed  {{\"text\": \"...\"}} or {{\"texts\": [...]}}")
    print(f"  POST /embeddings  (Ollama-compatible)")
    print(f"  POST /api/embeddings  (Ollama API path)")

    # Graceful shutdown
    def shutdown(sig, frame):
        print("\n[server] Shutting down ...")
        backend.unload()
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        shutdown(None, None)


if __name__ == "__main__":
    main()
