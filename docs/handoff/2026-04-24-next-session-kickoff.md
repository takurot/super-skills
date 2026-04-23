# Next-Session Kickoff — 2026-04-24

*Session 2026-04-23 (afternoon, ~5h). 5 commits shipped focused on
SIGKILL-137 cadence break + M2 phase-1 shadow deploy. Major outcomes:
SIGKILL-137 0 kills in 30+ min (prior cadence ~4h), sys_free floor 66x
improvement, jetsam pri 40→100 cutover, watchdog observability live,
evidence-gate shadow running log-only.*

---

## Session-start ritual (2 min)

```bash
# 1. Health baselines
curl -sS http://127.0.0.1:3150/health | python3 -c "import json,sys;d=json.load(sys.stdin);print('vcontext:',d['status'],'mlx:',d['mlx_available'])"
curl -sS http://127.0.0.1:3161/api/health | python3 -c "import json,sys;d=json.load(sys.stdin);print('mlx-embed backend:',d['backend'])"

# 2. Jetsam state (should still be app/100 after P0a)
APP=$(launchctl list | awk '$3 ~ /^application\.com\.vcontext\.server/ {print $3}' | head -1)
launchctl print gui/$(id -u)/"$APP" 2>&1 | grep -E "jetsam priority|jetsamproperties category"

# 3. SIGKILL-137 count since P0a cutover (should stay 0)
awk '/SIGKILL|exit.*137|code.*137/' /tmp/vcontext-server.log | awk '$1 > "2026-04-23T01:54:52"' | wc -l

# 4. Watchdog last emit (15s cadence — should be recent)
grep -E "rss.*heap.*swap.*sys_free" /tmp/vcontext-server.log | tail -1

# 5. M2 shadow evidence-gate-event count (FP sampling target after 48h)
curl -sS "http://127.0.0.1:3150/recent?type=evidence-gate-event&n=50" | python3 -c "import json,sys;d=json.load(sys.stdin);print('evidence-gate events:',len(d.get('results',[])))"

# 6. Swap (was 12.2 → 7.9 GB — expect stable or further drop)
sysctl -n vm.swapusage
```

---

## Today's 5 commits (2026-04-23 afternoon)

```
cc02df9  feat(hooks): M2 phase-1 shadow — pre-claim evidence gate (log-only)
907e76b  feat(vcontext): P0b-mmap 256/128 → 64 MB each (ramDb + ssdDb)
86f5b7a  feat(vcontext): P0b-heap 4096→2048 + fix env-load ordering bug
a069e0f  feat(vcontext): P0a cat=app migration — jetsam pri 40→100
441fb8c  feat(vcontext): P0d 15s watchdog for RSS/heap/swap observability
```

---

## Key outcomes

### 1. SIGKILL-137 cadence stopped
- **0 kills in ~30+ min** since P0a cutover at **10:54:52 JST** (prior cadence ~4h)
- Verification: `awk '/SIGKILL|exit.*137|code.*137/' /tmp/vcontext-server.log | awk '$1 > "2026-04-23T01:54:52"'` → 0 matches
- 4h-cadence break must still be confirmed over next 24h (first observation window)

### 2. sys_free floor improved 66x
- 46 MB → **3,000–5,000 MB** range
- Swap released 4.3 GB: 12.2 → **7.9 GB** used
- Watchdog P0d emits rss/heap/swap/sys_free every 15s for continued observability

### 3. Jetsam priority 40 → 100 (P0a)
- `cat=daemon pri=40` → `cat=app pri=100` via .app wrapping + bootout/bootstrap cycle
- vcontext server no longer first-victim under memory pressure
- Rollback: `p0a-rollback.sh` + `.bak-pre-p0a-20260423-103420` at `~/Library/LaunchAgents/`

### 4. wrapper.sh latent bug fixed (P0b-heap)
- `VCONTEXT_MAX_HEAP_MB` was a **silent no-op** — env-file sourced AFTER heap calculation
- Fix: reversed source order → env vars now honored
- Heap 4096 → 2048 MB (halved) — no ENOMEM observed post-cutover

### 5. mmap budget halved (P0b-mmap)
- ramDb 256 MB → **64 MB**, ssdDb 128 MB → **64 MB**
- Audit recommended 1-week observation before further mmap tuning
- Watch: `/recall` p95 latency — GC observation pending

### 6. M2 phase-1 shadow deployed (log-only)
- Fires on `Edit`/`Write`/`Task` when last assistant message contains
  `完了` / `done` / `complete` / `100%` AND no recent `Bash`/`Grep`/`Read`
- Writes `evidence-gate-event` to vcontext (claim_snippet + tool + timestamp)
- **Log-only mode** — zero user-visible impact; data collection for FP analysis

### 7. LLM-jp-4 MLX research
- **8B-thinking 4bit ready** (4.83GB) — viable as Japanese-task routing candidate
- 32B-A3B MoE viable but tight on 36GB unified memory
- No DWQ quant yet; safety tuning incomplete per README
- Integration deferred to Tier 2 pending M2 phase-2 completion

### 8. LLM-jp-4 daily research watch (user directive 2026-04-23)

User directive: **「LLM-jp-4 は調査は継続してて(すぐにではなく、毎日って意味)」**
→ 即座の投入ではなく、**毎日の動向観測** を継続タスクとして実行する。

Daily check (軽く、毎朝 1 回):
```bash
# 1. HuggingFace mlx-community llm-jp-4 新 variant
curl -s 'http://127.0.0.1:8888/search?q=mlx-community+llm-jp-4+new+variant&format=json' \
  | python3 -c "import json,sys;[print(r.get('title','?')[:80], '|', r.get('url','')) for r in json.load(sys.stdin).get('results',[])[:5]]"

# 2. llm-jp 公式 release ページ
curl -s 'https://llm-jp.nii.ac.jp/en/release-en/' 2>/dev/null | grep -iE 'llm-jp-4|release' | head -5

# 3. DWQ variant 公開されたか
curl -s 'http://127.0.0.1:8888/search?q=%22llm-jp-4%22+DWQ&format=json' \
  | python3 -c "import json,sys;print('DWQ hits:', len(json.load(sys.stdin).get('results',[])))"

# 4. safety-tuned / instruction-tuned 版の登場
curl -s 'http://127.0.0.1:8888/search?q=%22llm-jp-4%22+safety+RLHF+instruct&format=json' \
  | python3 -c "import json,sys;[print(r.get('title','?')[:80]) for r in json.load(sys.stdin).get('results',[])[:3]]"
```

Watch triggers (どれかでも発生したら Tier 2 検討昇格):
- [ ] DWQ 版公開 → Qwen3 と同等フットプリント + 8bit 品質で即投入候補
- [ ] safety-tuned / RLHF 版公開 → 現在の README 警告が解除 → skill-trigger 系に投入可
- [ ] 32B-A3B の 3bit-DWQ 公開 → 36GB で同居容易に
- [ ] NII が追加規模モデル公開(2026年度中予定) → 再評価トリガ
- [ ] Swallow チームが llm-jp-4 ベースの継続学習版を出した → 継続学習成熟度次第

結果は毎日 `vcontext` に `type=research-daily-watch, tag=llm-jp-4` で記録(ad-hoc script で OK、後日まとめて analyse)。

---

## Open monitoring tasks for next session

1. **M2 shadow FP sampling** (after 48h collection, target 2026-04-25 evening):
   ```bash
   curl -sS "http://127.0.0.1:3150/recent?type=evidence-gate-event&n=50" \
     | python3 -c "import json,sys;[print(x.get('created_at'),'|',json.loads(x['content']).get('claim_snippet','')[:80]) for x in json.load(sys.stdin).get('results',[])]"
   ```
   - Manually sample `claim_snippet` field
   - If **FP rate < 5%** → promote to **phase-2 (nudge mode)**
   - If FP rate ≥ 5% → tighten regex triggers before promotion

2. **SIGKILL-137 4h cadence break confirmation**:
   ```bash
   awk '/SIGKILL|exit.*137|code.*137/' /tmp/vcontext-server.log \
     | awk '$1 > "2026-04-23T01:54:52"'
   ```
   Should stay **0** across next 24h window. First 4h-cadence tick was expected ~14:54 JST today — skip-confirmation is the key signal.

3. **GC observation for P0b-mmap**:
   - Audit recommended 1-week observation before further mmap tuning
   - Watch `/recall` p95 latency for regression
   - Baseline capture before drawing conclusions

---

## Tier 1 queued work (immediate, small)

- [ ] **P0c mlx-embed retry storm fix** (~1.5h)
  - Exponential backoff + circuit breaker on :3161 connection failures
  - Prevents retry-amplification under pressure
- [ ] **M5 session-end retrospective** (~2h)
  - Compounds with M2 data for meta-loop feedback
  - Writes `session-retrospective` at session-end
- [ ] **M2 phase-2 (nudge mode)** — promote **only after 48h FP<5% confirmation**

---

## Tier 2 (decision-dependent)

- [ ] **LLM-jp-4 8B-thinking integration trial**
  - MLX launch on dedicated port (TBD 3163?)
  - `infinite-skills` routing candidate for Japanese tasks
  - 4.83GB weights already available locally
- [ ] **M3 second-opinion forcing** (~4h, depends on M5)
  - Soften "auto-spawn" pattern — second-opinion *reminder* not forced spawn

---

## Tier 3 (later)

- [ ] **M2 phase-3 (gate mode)** — after 1 full week of phase-2 nudge
- [ ] **M6 production-critical freeze** — last per spec (4 guards)

---

## Rollback safety nets

- **P0a**: `p0a-rollback.sh` restores pre-P0a plist; backup at `~/Library/LaunchAgents/*.bak-pre-p0a-20260423-103420`
- **P0b-heap**: env file revert — delete `data/vcontext.env` → wrapper falls back to 4096 default
- **P0b-mmap**: `git revert 907e76b`
- **M2 shadow**: log-only by design; disable via hook-config or `git revert cc02df9`
- **P0d watchdog**: pure observability; no behavior change to revert

---

## Do NOT do these (today's lessons)

1. **Do NOT use `launchctl kickstart -k gui/.../com.vcontext.server`** — does not restart under .app wrapping. Use the bootout + pkill + bootstrap sequence instead.
2. **Do NOT trust agent self-reports of Write/Edit** — always **Phase-A verify**: Read-back + `ls -la` + `cmp` against source. Today saw **2 agent misreport events** (T1 Ghost file, T3 wrapper-redirection false claim).
3. **Do NOT tune mmap further for at least 1 week** — P0b-mmap audit requires GC observation window before additional cuts.
4. **Do NOT promote M2 phase-2 before 48h FP data** — phase-1 is exactly for this measurement; skipping = violating spec-driven-dev.

---

## Decisions stored in vcontext this session

- `p0a-cat-app-migration` — .app wrapping + bootout/bootstrap is the correct restart path (not `kickstart -k`)
- `phase-a-verify-mandatory` — Read-back + ls + cmp is the minimum for Write/Edit verification after agent delegation
- `m2-shadow-48h-window` — FP sampling requires ≥48h log-only data before phase-2 promotion decision
- `mmap-1week-observation` — 64MB/64MB cut needs GC latency observation before further tuning

---

*End of handoff. Session closing 2026-04-23. Production green. SIGKILL cadence broken.*
