# LLM Recovery Mini-Spec (2026-04-21)

*Spec-driven-dev applied to the MLX-generate re-enable decision.
Created 2026-04-20 evening for tomorrow's go/no-go judgment.
Companion to `docs/handoff/2026-04-21-next-session-kickoff.md`
Priority 2.*

---

## Requirements

### Goal

Re-enable `com.vcontext.mlx-generate` (disabled since 2026-04-20
morning during the OOM-cascade recovery) so that the AIOS
self-evolve pipeline, skill-discovery research, and other local-
LLM consumers resume operation — without re-introducing the
2026-04-20 morning crash class.

### Acceptance Criteria

- **AC-R1**: Pre-flight memory headroom ≥ 8 GB (inactive + free
  pages ≥ 8 GB per `vm_stat`). Qwen3-8B-4bit-DWQ is ~6 GB, +2 GB
  margin for transient spikes during warm-up.
- **AC-R2**: `vcontext-server` SIGKILL-137 count did not increase
  in the **4 hours** prior to the enable attempt (soak
  condition). Measured via `grep -c "exited with code 137"
  /tmp/vcontext-server.log` delta.
- **AC-R3**: After `launchctl enable`, `launchctl print
  gui/<uid>/com.vcontext.mlx-generate` shows `state = running`
  within 60 s.
- **AC-R4**: First `POST :3163/v1/chat/completions` (via proxy,
  not :3162 directly) returns HTTP 200 within **120 s** (cold
  warm-up budget).
- **AC-R5**: During the warm-up and for 30 min after, concurrent
  `GET :3150/health` p95 stays < 100 ms.
- **AC-R6**: After 10 min idle, `GET :3163/proxy/health` reports
  `mlx_state=STOPPED` (auto-shutdown verified) and `vm_stat`
  shows ≥ 6 GB reclaimed vs peak.
- **AC-R7**: A second `POST :3163/v1/chat/completions` after
  auto-shutdown warms up correctly (AC-R4 again).

### Out of Scope

- Loading Qwen3.6-35B-A3B (deferred separately in
  `docs/roadmap/model-candidates.md`)
- Training / fine-tuning workflows
- Direct :3162 access — proxy-only contract
- Any code changes to the proxy itself

---

## Design

### Pre-flight (must all pass)

```bash
# 1. Soak condition — 4 h since last SIGKILL-137
LAST_CRASH=$(grep -c "exited with code 137" /tmp/vcontext-server.log)
UPTIME_S=$(ps -o etime= -p $(pgrep -f vcontext-server.js) | awk -F: '{ print ($1 * 3600) + ($2 * 60) + $3 }')
# require UPTIME_S >= 14400 (4 hours)

# 2. Memory headroom — ≥ 8 GB
vm_stat | awk '
  /Pages free/ {free=$3}
  /Pages inactive/ {inactive=$3}
  END { printf "%.1f\n", (free + inactive) * 16384 / 1073741824 }
'
# require ≥ 8.0

# 3. Server /health baseline
curl -sS -m 3 http://127.0.0.1:3150/health | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'))"
# require "healthy"

# 4. Proxy /health baseline
curl -sS -m 3 http://127.0.0.1:3163/proxy/health | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'),d.get('mlx_state'))"
# require "healthy STOPPED"
```

If any pre-flight fails, **abort** and diagnose before retrying.

### Enable

```bash
launchctl enable gui/$(id -u)/com.vcontext.mlx-generate
launchctl kickstart -k gui/$(id -u)/com.vcontext.mlx-generate
# wait 60s for bind
sleep 60
launchctl print gui/$(id -u)/com.vcontext.mlx-generate | grep state
# expect "state = running"
```

### Probe (AC-R4)

```bash
time curl -sS -m 180 -X POST http://127.0.0.1:3163/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mlx-community/Qwen3-8B-4bit-DWQ",
    "messages": [{"role": "user", "content": "Reply with a single word: OK."}],
    "max_tokens": 5
  }'
```

Expect 200 + content containing "OK" within 120 s.

### Observation (30 min)

Run in a second terminal:

```bash
for i in $(seq 1 120); do
  T=$(curl -sS -m 2 -o /dev/null -w '%{time_total}' http://127.0.0.1:3150/health)
  M=$(curl -sS -m 2 http://127.0.0.1:3163/proxy/health | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('mlx_state','?'))")
  VM=$(vm_stat | awk '/Pages free/{f=$3}/Pages inactive/{i=$3}END{printf "%.1f",(f+i)*16384/1073741824}')
  echo "$i: /health=${T}s mlx=${M} free+inactive=${VM}GB"
  sleep 15
done
```

Flags (AC-R5): any `/health` > 0.1 s or any absence response → investigate.

### Rollback

If any observation flag fires:

```bash
launchctl disable gui/$(id -u)/com.vcontext.mlx-generate
# proxy respects disable via is_service_disabled check
# verify:
curl -sS http://127.0.0.1:3150/health
# should still be healthy (disable should NOT crash the server)
```

Log the failure mode in `docs/analysis/` for diagnosis. Do not
re-enable until root cause is understood.

---

## Sequence

```
[user]                  [operator (Claude)]              [launchd]        [proxy :3163]         [mlx :3162]
  │                            │                           │                    │                    │
  │  "proceed with LLM" ──────►│                           │                    │                    │
  │                            │  pre-flight checks ──►    │                    │                    │
  │                            │   (soak 4h, mem 8GB)      │                    │                    │
  │                            │  if any fail → abort      │                    │                    │
  │                            │                           │                    │                    │
  │                            │  launchctl enable+ks ────►│                    │                    │
  │                            │                           │ start mlx-gen ─────┼───────────────────►│
  │                            │   sleep 60s               │                    │  bind :3162        │
  │                            │                           │                    │  ready             │
  │                            │  POST :3163/v1/... ──────────────────────────►│                    │
  │                            │                           │                    │  warm-up ─────────►│
  │                            │                           │                    │                    │ load model
  │                            │                           │                    │  stream response ◄─│
  │                            │  200 + content ◄──────────────────────────────│                    │
  │                            │                           │                    │                    │
  │                            │  observation loop (30m)   │                    │                    │
  │  status ticks ◄────────────│                           │                    │                    │
  │                            │                           │                    │                    │
  │                            │  (10 min idle)            │                    │                    │
  │                            │                           │                    │  auto-bootout ────►│ exit
  │                            │                           │                    │  mlx_state STOPPED │
  │                            │  vm_stat → 6GB freed      │                    │                    │
  │                            │                           │                    │                    │
  │                            │  second probe             │                    │                    │
  │                            │  POST :3163/v1/... ──────────────────────────►│  warm again ──────►│
  │                            │  200 ◄────────────────────────────────────────│                    │
  │                            │                           │                    │                    │
  │  report go/no-go ◄─────────│                           │                    │                    │
```

### Constraints

- Operator must not kick off any server restart during
  pre-flight soak measurement (uptime must be monotonic)
- Probe prompt is deliberately trivial (single-word reply) to
  minimize generation cost during cold warm-up validation
- Observation window is 30 min — enough to see auto-bootout
  cycle (10 min idle) + re-warm, not so long the operator
  context gets diluted

---

## Tasks

- [ ] 1. Pre-flight: run soak + memory + health checks. Satisfies AC-R1, AC-R2.
- [ ] 2. `launchctl enable` + kickstart. Satisfies AC-R3.
- [ ] 3. First probe — Qwen3-8B warm-up response. Satisfies AC-R4.
- [ ] 4. Start concurrent /health polling (backgrounded). Monitors AC-R5.
- [ ] 5. 30 min observation window — no crashes. Satisfies AC-R5.
- [ ] 6. 10 min idle → verify mlx_state=STOPPED + vm_stat. Satisfies AC-R6.
- [ ] 7. Second probe — warm-up again. Satisfies AC-R7.
- [ ] 8. Report outcome; if go, remove the "mlx-generate disabled"
       note from handoff and stability checklist.

---

## Decision gate

Before starting, confirm all of:

- [ ] User explicitly requested LLM re-enable (H2 propose-then-execute)
- [ ] Stage 4.5 C9 either shipped or explicitly deferred past this
      soak window (so C9 deployment doesn't interfere with uptime)
- [ ] This session's last commit was ≥ 4 h ago (AC-R2 direct check)
- [ ] Operator has 30 min of continuous attention available
      (observation window is not pauseable)

If any fail, pause and address. Do not proceed partway.

---

## Related artifacts

- Handoff: `docs/handoff/2026-04-21-next-session-kickoff.md` P2
- Proxy spec: `docs/specs/2026-04-20-mlx-lazy-load-proxy.md`
- Stability audit: `docs/analysis/2026-04-20-server-instability-diagnosis.md`
- Model candidates: `docs/roadmap/model-candidates.md`
- MLX lazy-load + memory-pressure gate: commit `7484527`
