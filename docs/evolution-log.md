# Evolution Log

Auto-maintained by the `self-evolve` skill. Records all upstream syncs, web discoveries, and self-improvements.

---

## 2026-04-18 — 論文ソース補足 + 参照先リンク再帰チェック

**Search window**: 2026-04-16 → 2026-04-18
**調査カテゴリ**: arXiv 論文 / Papers with Code / Semantic Scholar / 既発見記事の参照先リンク
**論文ソース数**: arXiv 9本確認（うち深掘り 6本）
**参照先リンク数**: 4記事 × 最大3リンク = 12リンク確認（深掘り 7ページ）
**新規候補**: 4件 | **採用（pending-patch 登録）**: 2件 | **スキップ**: 2件

### 論文ソース評価（Fitness スコア）

weights: novelty 0.25, proven 0.25, safe 0.20, actionable 0.20, freshness 0.10

| Candidate | novelty | proven | safe | actionable | freshness | fitness | source |
|-----------|---------|--------|------|-----------|-----------|---------|--------|
| tool-context-budget | 0.80 | 0.90 | 1.00 | 0.90 | 0.85 | **0.88** | azukiazusa.dev + Anthropic Engineering Blog |
| skill-security-audit | 0.85 | 0.80 | 1.00 | 0.80 | 0.80 | **0.83** | arXiv:2602.12430 |
| speculative-tool-exec | 0.85 | 0.85 | 0.95 | 0.65 | 0.90 | **0.83** | arXiv:2603.18897 |
| dynamic-workflow-graph | 0.75 | 0.85 | 1.00 | 0.60 | 0.90 | **0.78** | arXiv:2603.22386 |

### Action: pending-patch 登録 — tool-context-budget (fitness=0.88)

- **Source**: azukiazusa.dev「MCP Tool Context Overflow — Solutions and Patterns」(2026) + Anthropic Engineering「Equipping Agents for the Real World with Agent Skills」
- **Reasoning**: MCP ツール定義のトークン消費管理ワークフロー（3パターン）。実測で 55.7k tokens の 27.9% がツール定義に消費されることが確認済み。既存の `mcp-server-patterns` はプロトコル仕様・セキュリティが中心で、コンテキスト予算管理ワークフローは不在。3パターン（progressive disclosure / code-execution bridge / search-based discovery）は具体的 actionable チェックリストあり。2独立ソース確認済み。
- **vcontext id**: 129212
- **Risk assessment**: low — 新スキル、既存スキルへの変更なし

### Action: pending-patch 登録 — skill-security-audit (fitness=0.83)

- **Source**: arXiv:2602.12430「Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward」(2026-02-12, Renjun Xu, Yang Yan)
- **Reasoning**: コミュニティ提供スキルの 26.1% に脆弱性が含まれることが実証済み（arXiv 論文）。Anthropic Engineering ブログでも「信頼できるソースのみからインストールし、スクリプトを審査すること」と明示。既存の `security-review` はコードレビュー対象。`skill-security-audit` はスキルファイル自体の supply chain attack / prompt injection / exfiltration 審査ワークフローで差別化。具体的な 5カテゴリ チェックリスト + リスク分類表あり。
- **vcontext id**: 129215
- **Risk assessment**: low — 新スキル、既存スキルへの変更なし

### Skipped: speculative-tool-exec (fitness=0.83)

- **Source**: arXiv:2603.18897「Act While Thinking: Accelerating LLM Agents via Pattern-Aware Speculative Tool Execution」(2026-03-19, PASTE)
- **Reasoning**: ツール実行待機時間を 48.5% 削減するパターン（制御フロー予測 + データ依存性予測）。novelty・freshness は高いが、actionable スコアが低い（実装がエージェントランタイム深部への組み込みを要する）。SKILL.md ワークフローとして表現しにくい。次サイクルで PASTE の実装が成熟したら再評価。

### Skipped: dynamic-workflow-graph (fitness=0.78)

- **Source**: arXiv:2603.22386「From Static Templates to Dynamic Runtime Graphs: A Survey of Workflow Optimization for LLM Agents」(2026-03-23, RPI & IBM Research)
- **Reasoning**: 実行時にトポロジを生成・編集する動的エージェントグラフ。`supervisor-worker` との差別化はあるが、actionable スコアが低い（具体的な手順より理論的なフレームワーク）。かつ実装にはグラフ管理インフラが必要。`supervisor-worker` の注記に追加する形で対応可能。

### 論文調査 — スキップ論文（参照のみ）

| 論文 | arXiv ID | スキップ理由 |
|------|----------|------------|
| The Evolution of Tool Use in LLM Agents | 2603.22862 | 調査論文。6次元フレームワークは概念的で actionable なワークフロー不在 |
| Learning to Rewrite Tool Descriptions | 2602.20426 | カリキュラム学習ベース。SKILL.md ワークフローとして実装不可 |
| Multi-Agent Teams Hold Experts Back | 2602.01011 | 発見（合意志向の落とし穴）は confidence-filter / debate-consensus で既カバー |
| SciFi (Scientific Agentic Workflow) | 2604.13180 | 科学計算特化、汎用スキルとして抽出不可 |
| How Well Do Agentic Skills Work in the Wild | 2604.04323 | ベンチマーク論文。設計への示唆あり（query-specific refinement）だがスキル化不要 |
| Externalization in LLM Agents | 2604.08224 | 調査論文。Memory/Skills/Protocols/Harness の4層フレームワークは既存設計を支持するが新スキル不要 |

### 参照先リンク 再帰チェック — 新規発見なし

| 元記事 | 確認リンク | 結果 |
|--------|-----------|------|
| Zenn nanahiryu Claude Code Skills | azukiazusa.dev (context-overflow) | **採用** → tool-context-budget |
| Zenn nanahiryu Claude Code Skills | builder.io/blog/agent-skills-rules-commands | `careful` / rules vs skills 区別は既知。新スキル不要 |
| Zenn nanahiryu Claude Code Skills | agentskills.io/home | 標準仕様確認。新スキル不要 |
| Qiita 53スキル記事 | 404 | アクセス不可 |
| DevelopersIO Agent Teams | code.claude.com/docs/ja/agent-teams | 実験的機能、前回スキップ済み |
| AI Watch Claude Managed Agents | claude.com/blog/claude-managed-agents | 前回 fitness=0.73 でスキップ済み、評価変更なし |

### 今回サイクル合計 pending-patch

| ID | スキル名 | fitness | cycle_id |
|----|---------|---------|---------|
| 129030 | ultraplan | 0.93 | 2026-18 |
| 129033 | autofix-pr | 0.89 | 2026-18 |
| 129036 | generator-verifier | 0.84 | 2026-18 |
| **129212** | **tool-context-budget** | **0.88** | **2026-18** |
| **129215** | **skill-security-audit** | **0.83** | **2026-18** |

---

## 2026-04-18 — web-discovery + upstream-sync (+ 日本語サイト追加検索)

**Search window**: 2026-04-16 → 2026-04-18
**Queries executed**: 8 + 5（日本語サイト追加分）
**New sources checked**: 14（WebFetch deep dives: 7ページ）+ 14（日本語サイト: WebSearch 5クエリ + WebFetch 5ページ）
**Candidates found**: 5 + 4（日本語ソース） | **Adopted (pending-patch)**: 3 | **Skipped**: 2 + 4（日本語ソース、top-3 変更なし）

### Upstream Sync: 変更なし
- **Reasoning**: `git fetch upstream` + `git log upstream/main ^HEAD --since=2026-04-16` で新規コミットなし。upstream に採用対象の変更なし。

### vcontext ソース確認
- `pending-idea`: 0件
- `pending-patch`: 0件
- `skill-suggestion`: 0件

### Fitness スコア（weights デフォルト: novelty 0.25, proven 0.25, safe 0.20, actionable 0.20, freshness 0.10）

| Candidate | novelty | proven | safe | actionable | freshness | fitness |
|-----------|---------|--------|------|-----------|-----------|---------|
| ultraplan | 0.95 | 0.95 | 1.00 | 0.95 | 0.85 | **0.93** |
| autofix-pr | 0.90 | 0.90 | 0.90 | 0.90 | 0.85 | **0.89** |
| generator-verifier | 0.75 | 0.90 | 1.00 | 0.85 | 0.70 | **0.84** |
| message-bus-agents | 0.80 | 0.85 | 1.00 | 0.75 | 0.70 | **0.82** |

### Action: pending-patch 登録 — ultraplan (fitness=0.93)
- **Source**: 公式 Claude Code Docs, Week 15 (April 6-10, 2026) — code.claude.com/docs/en/ultraplan
- **Reasoning**: `/ultraplan` コマンドによるクラウドプラン生成ワークフロー。既存の `plan-architecture` スキルはローカル設計プロセスをカバーするが、ultraplan はクラウドでのバックグラウンド生成・ブラウザでのセクション別インラインコメント・web/terminal の実行先選択という完全に異なるワークフロー。公式ドキュメントで実証済み、具体的コマンド付き。
- **vcontext id**: 129030
- **Risk assessment**: low — 新スキル、既存スキルへの変更なし

### Action: pending-patch 登録 — autofix-pr (fitness=0.89)
- **Source**: 公式 Claude Code Docs, Week 15 (April 6-10, 2026) — code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests
- **Reasoning**: `/autofix-pr` コマンドによる自律的PRクローズループ。クラウドエージェントが CI 失敗とレビューコメントを監視し続け、修正コミットを自動プッシュする。既存45スキルに不在。マージ前の手動 CI 修正サイクルを自動化する実用的なワークフロー。
- **vcontext id**: 129033
- **Risk assessment**: low — 新スキル、ブランチへのコミットは自動だが review 前にユーザーが確認可能

### Action: pending-patch 登録 — generator-verifier (fitness=0.84)
- **Source**: Anthropic 公式ブログ "Multi-agent coordination patterns" (claude.com/blog/multi-agent-coordination-patterns) + Beam AI "9 Agentic Workflow Patterns 2026"
- **Reasoning**: 生成→検証→フィードバックループの品質保証パターン。`adversarial-review` との差別化: adversarial-review は既存コードへの悪意ある検証、generator-verifier は新規出力の基準適合ループ。2つ以上の独立ソースで確認済み。コード生成・コンプライアンスコンテンツ・API レスポンス等に応用可能。
- **vcontext id**: 129036
- **Risk assessment**: low — 新スキル、既存スキルへの変更なし

### Skipped: message-bus-agents (fitness=0.82)
- **Reasoning**: Anthropic 公式ブログで5パターンの一つとして確認。ただし、具体的な実装ステップが `supervisor-worker` パターンとの差別化に不十分。イベントバス/パブサブ基盤の実装詳細を含む独立したワークフローとして成立させるにはさらなる情報源が必要。次サイクルで再評価。

### 日本語ソース追加検索（2026-04-18 追記）

**追加検索ソース:**
- `site:zenn.dev` — "Claude Code スキル 2026" + "AIエージェント パターン 2026"
- `site:qiita.com` — "Claude Code スキル 2026"
- `site:dev.classmethod.jp` — "AIエージェント 2026 Claude Code"
- `site:ai.watch.impress.co.jp` — 最新AI記事（2026年4月）

**日本語候補の Fitness スコア**（weights デフォルト: novelty 0.25, proven 0.25, safe 0.20, actionable 0.20, freshness 0.10）

| Candidate | novelty | proven | safe | actionable | freshness | fitness | source |
|-----------|---------|--------|------|-----------|-----------|---------|--------|
| skills-evolve | 0.80 | 0.75 | 0.90 | 0.85 | 0.55 | **0.77** | Qiita (2026-03-14) |
| review-squad | 0.70 | 0.75 | 1.00 | 0.80 | 0.55 | **0.75** | Qiita (2026-03-14) |
| Claude Managed Agents | 0.65 | 0.90 | 1.00 | 0.55 | 0.65 | **0.73** | AI Watch (2026-04-10) |
| agent-teams | 0.70 | 0.80 | 0.85 | 0.65 | 0.60 | **0.72** | DevelopersIO (2026-02-09) |

**判定: top-3 変更なし**（ultraplan 0.93 / autofix-pr 0.89 / generator-verifier 0.84 が依然上位）

**次サイクル再評価候補:**

- **skills-evolve** (fitness=0.77): ツール呼び出し履歴と SKILL.md 定義の乖離を検出→自動修正するメタレイヤー（Qiita: Claude Code に53個のスキルを仕込んだら、AIが自分自身を改善し始めた話 / 2026-03-14）。`self-evolve` スキルとはアプローチが異なる（実行履歴ベースの差分検出）が、英語ソースでの独立確認が取れていない。freshness 0.55（2026-04-16 以前）。次サイクルで英語 counterpart を探索。
- **review-squad** (fitness=0.75): 差分ファイル数に応じて 3〜10 体のレビューエージェントを自動スケーリング選択（Qiita: 2026-03-14）。`confidence-filter` + `supervisor-worker` の組み合わせに部分的に収まるが、「PR サイズベース動的スケーリング」という具体的ロジックは不在。英語ソース確認待ち。
- **Claude Managed Agents** (fitness=0.73): Anthropic が4/8 発表の本番エージェントインフラ（サンドボックス、チェックポイント、認証情報管理、E2E トレース）。スキルとして抽象化するには actionable が低い。`claude-routines` スキルへの注記追加で対応可能。AI Watch 記事: https://ai.watch.impress.co.jp/docs/news/2100770.html
- **agent-teams** (fitness=0.72): ピアツーピアのエージェント直接通信（DevelopersIO: 2026-02-09）。2026-04-17 run で既に「実験的機能、supervisor-worker と重複」として Skipped。評価変更なし。

**Skipped（このサイクル）:**

- ReAct / Self-Reflection パターン (Zenn: 2026-02-14) — freshness 低（2026-04-16 以前）、かつ既存 `verification-loop` + `debate-consensus` でカバー済み。
- マルチエージェントオーケストレーション比較 (Zenn: 2026-01-19) — 英語ソースで既確認のパターン集で novelty 低。

### Skipped: ultrareview (fitness計測外)
- **Reasoning**: 4/16 以前に Week 14 でリリース済み (v2.1.86)。フレッシュネス条件（2026-04-16以降）を満たさないため対象外。

---

## 2026-04-17 (PM) — self-improvement: stability + performance + naming

**Type**: self-improvement (interactive session, 34 commits)
**Trigger**: user reported dashboard was slow and had "MLX Generate: off" despite service being up. Opened a chain of investigations that surfaced real operational pain.

### Action: created — Morning Brief automation
- **Target**: new `scripts/vcontext-morning-brief.sh` + LaunchAgent
  `com.vcontext.morning-brief` + endpoint `GET /admin/health-report?days=N`
- **Reasoning**: nightly aggregate was only accessible via dashboard; turning
  it into a macOS notification at 9am gives a passive daily pulse without
  opening the UI. Brief saved to `data/morning-briefs/YYYY-MM-DD.txt`;
  optional Slack/Discord via `VCONTEXT_BRIEF_WEBHOOK`.
- **Risk assessment**: low (read-only endpoint + local notification)

### Action: improved — data protection (multi-layer)
- **Target**: `scripts/vcontext-server.js`
- **Reasoning**: user insight — "生成データは再生成できるが、元データは再取得できない." A simple snapshot-restore on DB corruption would lose every raw entry written after the snapshot. Built a layered durability chain:
  1. Async SSD write-through with matching id (keeps RAM/SSD aligned)
  2. Append-only JSONL log at `data/entries-wal.jsonl` (SQLite-independent)
  3. 1-min `rawSyncTimer` catch-up (shrinks loss window from 5 min → 1 min)
  4. `checkAndRecoverDb` salvages corrupt DB via `sqlite3 .recover` before
     restoring snapshot, then merges unique entries back
  5. `POST /admin/replay-wal` / `GET /admin/wal-status` endpoints
- **Verified**: E2E recovery test saved to
  `docs/analysis/2026-04-17-recovery-e2e-verification.md` — deliberately
  corrupted a 1.8GB DB, recovered 39,185 entries in 32s, merged with older
  snapshot to 45,649 unique (strict superset), final `quick_check` = ok.
- **Risk assessment**: low (all paths non-destructive, verified)

### Action: improved — performance (cascading lock-bypass)
- **Target**: `scripts/vcontext-server.js`
- **Recall latency**: root cause was semantic fallback acquiring `withMlxLock`
  while the background embed loop held the lock. Added `mlxEmbedFast` (bypass
  lock + 2s timeout + 50-entry LRU cache). Measured:
    recall avg  3184ms → 1286ms (→ 642ms post-reboot)
    recall max  25040ms → 3599ms (→ 2787ms)
    store max   38145ms → 3337ms (recall's knock-on effect)
    recent max  16226ms → 286ms (56x)
- **Embed throughput**: same lock issue on the loop side — it was queued
  behind failed store-time 60s timeouts. Switched to `_mlxEmbedBatchRaw`
  (direct). Added checkMlx hysteresis + await in loop (mirror of
  checkMlxGenerate fix). After reboot: 0/min → 45/min steady.
- **Dashboard bandwidth**: `/recent?short=1` truncates content to 500
  chars server-side + drops embeddings from responses. `/ai/status`
  collapsed 6 full-table COUNT(*) into one SUM(CASE) aggregate. Total
  payload per refresh: 3.5 MB → 225 KB (94% reduction). /ai/status
  1199 ms → 682 ms.
- **Risk assessment**: medium (changes hot paths); verified via before/after
  SQL metrics and manual probes.

### Action: improved — Qwen3 `/no_think` for extractive tasks
- **Source**: A/B experiment `scripts/experiment-thinking-skip.sh`
- **Reasoning**: Qwen3's `<think>...</think>` block burns 100-400 tokens on
  summarization tasks where the answer is already extractive. Measured
  15,765ms avg with thinking vs 1,472ms with `/no_think` prepended.
  Quality equivalent (0/3 `<think>` leak, same summary content).
- **Applied noThink: true** to: handleStore auto-summarize, /ai/summarize
  (bulk + per-id), runOnePrediction keyword extraction. Kept thinking for
  reasoning-heavy callers (resolve, skill creation, rule violations).
- **Risk assessment**: low (opt-in; reasoning callers untouched)

### Action: improved — Anomaly auto-response
- **Target**: `scripts/vcontext-server.js`
- **Reasoning**: `detectAnomalies()` stored alerts but nothing acted. Added
  `respondToAnomalies()` with per-kind handlers:
    embed-stall     → launchctl kickstart mlx-embed
    ram-ahead       → force syncRamToSsd()
    ram-disk-full   → wal_checkpoint(TRUNCATE) + migrateRamToSsd() + macOS
                       critical notification
    error-spike     → macOS notification only (needs diagnosis)
  Guardrails: 5-min per-kind cooldown (`_anomalyLastAction` Map), every
  action logged as type='anomaly-response' audit entry.
- **Risk assessment**: low-medium (kickstart + checkpoint are safe; cooldown
  prevents flap)

### Action: improved — RAM disk 4GB → 6GB
- **Target**: `scripts/vcontext-setup.sh` (RAM_BLOCKS = 12582912)
- **Reasoning**: 4GB was filling to ~62% steady-state; after yesterday's
  corruption incident (100% full → DB malformed), giving more headroom
  between normal use and the 95% watchdog cleanup threshold. Applied on
  mac reboot — current state 5.8 GB at 35% used.
- **Risk assessment**: low (config change, applies on next boot)

### Action: improved — checkMlxGenerate / checkMlx hysteresis
- **Target**: `scripts/vcontext-server.js`
- **Reasoning**: Both probe functions had `catch { flag = false }` with no
  logging and no hysteresis. One transient failure flipped the flag for
  the rest of the 5-min cycle. During MLX restart windows this silently
  disabled discovery, predict, and auto-summarize.
- **Fix**: 3-consecutive-failure streak before flipping to false + log on
  first failure + log only on false→true transitions. Embed-loop now
  awaits `checkMlx()` so the flag reflects the latest probe before deciding
  to skip.
- **Risk assessment**: low (loosened, not tightened, so at worst stays
  "available" slightly longer during real outages — harmless)

### Action: refactor — super-skills → infinite-skills
- **Target**: full repo + 5 deploy targets (claude/codex/cursor/kiro/antigravity)
- **Reasoning**: user requested renaming for clearer semantics. Auto-router
  was supposed to have been unified into super-skills earlier but residue
  remained (skill-registry DB entry, manifests, 2 server.js fallbacks).
  Combined cleanup + rename.
- **Changes**:
  - `skills/super-skills/` → `skills/infinite-skills/` (including internal
    `name:` field)
  - `plugins/claude/hooks/super-skills.hooks.json` → `infinite-skills.hooks.json`
  - Scheduled task `super-skills-evolve` → `infinite-skills-evolve`
  - 10 source files updated (build-*, vcontext-*, install-lib,
    validate-configs, skills/README.md, self-evolve/SKILL.md, plugin docs)
  - 32 DB `skill-trigger` rows rewritten (auto-router → super-skills → infinite-skills)
  - `~/.claude/CLAUDE.md` routing reference updated
  - `~/.codex/AGENTS.md` routing reference updated
  - Hand-deployed to ~/.cursor/rules/skills/, ~/.kiro/skills/,
    ~/.antigravity/skills/ (earlier install-apply had no manifest entry
    for infinite-skills; added it so future installs carry it automatically)
- **Preserved**: `scripts/sync-upstream.sh` references to
  `takurot/super-skills` (external GitHub repo name, not skill name)
- **Risk assessment**: low — mechanical rename, all 5 targets verified

### Bug fixes (captured in commit log)
- `truncated is not defined` in /session/:id — variable orphaned after
  pagination refactor
- `malformed JSON` flood on /analytics/skill-effectiveness — SQLite pushes
  json_each above type filter in every plan shape tried (CTE/MATERIALIZED/
  subquery); switched to pure-JS aggregation
- watchdog pgrep mis-identified MLX generate (looked for wrapper name;
  wrapper execs `python3 -m mlx_lm.server` so pattern never matched) →
  perpetual restart loop every 60s. Fixed pattern to match actual cmdline.
- watchdog singleton guard added via /tmp/vcontext-watchdog.pid
- MLX memory threshold 8GB → 14GB (was catching steady-state, flap-killing
  the server indirectly)
- Dashboard `var recent = ...` shadowed outer `const recent` →
  parse-time SyntaxError froze the page at "Loading...". Renamed to
  `recentCreated`. Added `Cache-Control: no-cache` so future fixes reach
  browsers without a manual hard refresh.
- `/ai/status` 1.2s → 682ms via single-scan aggregate
- MLX embed server `/embed_batch` deadlock detected — watchdog /health
  probe is too shallow to catch it (known gap; kill+launchd restart
  clears it, deferred fixing the watchdog probe)

### Observability / hygiene
- Dashboard "Data Protection" card (JSONL WAL status + defense-in-depth
  explainer)
- Dashboard Metrics card labels disambiguated lifetime vs period values
  (skills: lifetime total + in-period; tokens: Prior pre-Nh / New in Nh /
  Total lifetime; store-latency: Xms/write · Nh)
- `entry_index` orphan cleanup: purged 28,538 stale rows + incremental
  sweep added to 5-min tick

### Files touched this session
34 commits on `main`. Summary: 1 new skill (morning-brief), 1 skill rename
(super-skills → infinite-skills), 1 experiment script, 1 analysis doc,
1 LaunchAgent plist, substantial edits to vcontext-server.js /
vcontext-watchdog.sh / vcontext-dashboard.html, manifest updates for
install-apply.mjs.

### Rollback
Any individual commit revertible via git. Data safe by design (async
write-through + JSONL log + multiple snapshots).

---

## 2026-04-17 — web-discovery + upstream-sync

**Search window**: 2026-04-16 → 2026-04-17
**Queries executed**: 18
**New sources checked**: 63 (WebFetch deep dives: 7 pages)
**Candidates found**: 6 | **Adopted**: 3 | **Skipped**: 4 | **Flagged**: 0

### Upstream Sync: surgical (no merge — conflict-free)
- **Reasoning**: Full `git merge upstream/main` would create 30+ modify/delete conflicts because we had deleted `.claude/skills/` built artifacts in a previous cleanup, but upstream modified them (added `user-invocable: true`). Took surgical approach: copied 24 skill source files directly from `upstream/main:skills/` into our `skills/` directory without triggering merge conflicts. All 23 of 24 upstream skills were already registered in vcontext from prior runs; added the missing `mcp-server-patterns` registration. Validated 28/28 skills, deployed, committed.
- **Skills from upstream**: api-design, backend-patterns, careful, checkpoint, coding-standards, deep-research, dmux-workflows, documentation-lookup, e2e-testing, exa-search, freeze, frontend-patterns, guard, health-check, investigate, mcp-server-patterns, plan-architecture, plan-product, qa-browser, review, security-review, ship-release, tdd-workflow, verification-loop

### Action: created — adversarial-review
- **Source**: "Agent Skills: The Cheat Codes for Claude Code" (Medium, Jonathan Fulton, April 2026) — multi-source confirmed; Codex Review Plugin adversarial mode cited as catching race conditions that survived 3 human review rounds
- **Reasoning**: Novel and distinct from standard `review` skill. Adversarial review acts as a devil's advocate — actively tries to break code by probing race conditions, null paths, edge cases, and weak architectural assumptions. Routed at P4 alongside `review` and `security-review`.
- **Changes**: Created `skills/adversarial-review/SKILL.md`. Added to super-skills routing at P4: `adversarial-review(try to break/edge case/race condition)`. Registered in vcontext (id=117905).
- **Risk assessment**: low — new skill, no modification to existing skills

### Action: created — gh-skill-manager
- **Source**: GitHub Blog Changelog, April 16, 2026 — "Manage Agent Skills with GitHub CLI" (v2.90.0). Primary source (official GitHub changelog). Commands: `gh skill install/search/preview/update/publish`, `--agent claude-code|cursor|codex|gemini` flag, immutable releases via git tags, content-addressed SHA tracking.
- **Reasoning**: Novel skill (shipped the same day as this run). Cross-agent skill portability is now standardized. The `gh skill` CLI is a package-manager-grade tool for distributing and versioning AI agent skills with supply chain security guarantees. Directly relevant to managing this skill framework.
- **Changes**: Created `skills/gh-skill-manager/SKILL.md`. Added to super-skills routing at P7: `gh-skill-manager(install/update/publish agent skill/gh skill CLI)`. Registered in vcontext (id=117904).
- **Risk assessment**: low — new skill

### Action: improved — mcp-server-patterns
- **Source**: Cloudflare Enterprise MCP Reference Architecture (blog.cloudflare.com/enterprise-mcp/) — "lazy discovery" two-tool pattern. MCP Server Security Best Practices 2026 (Medium) — OAuth 2.1 per-tool scopes as mandatory standard.
- **Reasoning**: Two concrete improvements to existing thin skill: (1) Lazy tool discovery — expose only 2 tools (search + execute) so agents discover capabilities on demand, solving context exhaustion at 10,000+ server scale; (2) Per-tool OAuth 2.1 scopes (calendar:read, email:send, contacts:delete) — now mandatory standard for HTTP transports per 2026 security guidance. Updated vcontext entry (id=117906).
- **Changes**: Expanded `skills/mcp-server-patterns/SKILL.md` from 19 to 39 lines.
- **Risk assessment**: low — incremental improvement

### Skipped: Claude Code Agent Teams
- **Reasoning**: Experimental feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, v2.1.32+) — peer-to-peer agent messaging with shared task lists and file locking. Interesting but still experimental, and overlaps significantly with our existing `supervisor-worker` skill. Will re-evaluate when stable.

### Skipped: Kiro cross-session memory patterns
- **Reasoning**: Kiro (AWS agentic IDE) implements persistent cross-session memory and multi-repo unified tasks with review-driven learning. Architecturally interesting but platform-specific (Kiro only). Not portable to our Claude Code + vcontext framework.

### Skipped: Trust Wall / AI governance checklist
- **Reasoning**: "Trust Wall" framing for AI-caused production incidents (Gravitee State of AI Agent Security 2026, Lightrun). Governance gap between model-level guardrails and runtime enforcement. Covered sufficiently by existing `careful`, `guard`, and `security-review` skills. Not differentiated enough for a new skill.

### Skipped: Progressive Disclosure prompt pattern
- **Reasoning**: Phase-gated instructions so agents receive detail only at the relevant phase (from Paxrel AI Agent Prompt Engineering 2026). Already covered by our `phase-gate` skill in ~/.claude/skills/.

### Step 3: Local AI Model Maintenance
- **MLX generate**: Server was DOWN at run start (port 3162 ECONNREFUSED). Restarted via wrapper script. Running: `mlx-community/Qwen3-8B-4bit` + `Qwen/Qwen3-0.6B-MLX-4bit` draft (speculative decoding). Model unchanged — current setup still optimal.
- **MLX embed**: Running — `mlx-community/Qwen3-Embedding-8B-4bit-DWQ` (dim=4096). Embedding backlog: 16,829 entries queued.
- **Decision**: No model upgrades this run. MLX generate restart was the only action needed.

### Step 4: Hook Auto-Setup
- **Detected tools**: Claude Code, Codex, Cursor, Kiro
- **Result**: Claude Code already configured; Codex hooks.json refreshed (backed up previous); Cursor and Kiro hooks updated
- **No new tools detected** since last run

### Infrastructure improvements committed
- `vcontext-server.js`: Added DB integrity check + corruption recovery (PRAGMA integrity_check → salvage raw entries → restore from snapshot → merge salvaged back). Preserves user prompts/tool calls that cannot be regenerated.
- `vcontext-watchdog.sh`: Added RAM disk capacity monitoring — WARN at 85%, emergency cleanup at 95% (WAL checkpoint + corrupt backup removal + macOS notification).

---

## 2026-04-16 — web-discovery

**Search window**: 2026-04-15 → 2026-04-16
**Queries executed**: 11
**New sources checked**: 18 (WebFetch deep dives: 4 pages)
**Candidates found**: 4 | **Adopted**: 1 | **Skipped**: 3 | **Flagged**: 0

### Upstream Sync: skipped
- **Reasoning**: All 19 changed files show our local ahead of upstream (our extensions — MCP 2026 content, eval-driven-dev, etc. — not present in upstream). No upstream content to adopt. Same situation as 2026-04-15.

### Action: created — claude-routines
- **Source**: Official Anthropic documentation (code.claude.com/docs/en/routines), SiliconAngle/9to5Mac/The Register — all from April 14, 2026 launch
- **Reasoning**: Brand-new Anthropic platform feature (launched April 14, 2026, research preview). Three trigger types: scheduled (hourly/daily/weekly), API (HTTP POST endpoint with bearer token), GitHub events (pull_request, release). Runs on Anthropic-managed cloud infrastructure — keeps running when laptop is closed. This is distinct from our existing `schedule` skill (which uses CCD session RemoteTrigger/CronCreate tools). No overlap with existing skills. Novel, proven (official docs), safe, actionable as a workflow skill.
- **Changes**: Created `skills/claude-routines/SKILL.md` with: trigger type comparison table, CLI/web/API creation workflows, autonomous prompt template, 6 use case examples, safety scope checklist, plan limits table. Added to `install-components.json`. Added to `super-skills` routing at P5 (dev): `claude-routines(automate/routine/schedule cloud/GitHub trigger)`. Registered in vcontext skill-registry (id=110202). Also back-registered `eval-driven-dev` (id=110205) which was created yesterday but not in vcontext registry.
- **Risk assessment**: low — new skill, no modification to existing skills

### Skipped: durable-execution patterns
- **Reasoning**: Fault-tolerant step-based agent workflows (Cloudflare Workflows v2, Temporal, AWS Durable Functions). Multi-source confirmed but not actionable as a SKILL.md workflow — it's infrastructure guidance for platform engineers. Requires specific platform choices (Temporal, Cloudflare Workers) that are too implementation-specific for a generic skill.

### Skipped: agent-memory improvements
- **Reasoning**: File-based memory with consolidation, shared learnings.md, episodic-to-semantic conversion patterns. Our existing `agent-memory` skill already covers AGENTS.md-based institutional memory. The new patterns (periodic consolidation, curator-only writes) are interesting but not differentiated enough from what we have to justify a new skill or major update.

### Skipped: Hermes Agent self-evolution
- **Reasoning**: NousResearch Hermes Agent v0.7.0 (April 15, 2026) — writes reusable SKILL.md files to SQLite after each task, searches memory for similar future tasks. Interesting self-evolution approach, but this is a separate framework pattern, not a SKILL.md workflow applicable to our system. Our vcontext skill-registry already implements a similar recall-and-reuse pattern.

### Step 3: Local AI Model Maintenance
- **MLX generate**: Qwen3-8B-4bit — confirmed available and healthy (mlx_generate_available: true)
- **MLX embed**: CoreML available (coreml_available: true)
- **Decision**: No model changes this run — same status as yesterday, stable

### Step 4: Hook Auto-Setup
- **Detected tools**: Claude Code, Codex, Cursor, Kiro
- **Result**: Claude Code already configured; Codex hooks.json refreshed (backed up previous); Cursor and Kiro hooks updated
- **No new tools detected** since last run

---

## 2026-04-15 — web-discovery

**Search window**: 2026-04-14 → 2026-04-15
**Queries executed**: 7
**New sources checked**: 14 (WebFetch deep dives: 6 pages)
**Candidates found**: 5 | **Adopted**: 2 | **Skipped**: 3 | **Flagged**: 0

### Upstream Sync: skipped
- **Source**: takurot/super-skills upstream/main (commits 4ea4b21, 80f8c72)
- **Reasoning**: Upstream restructured to filesystem-based skill deployment (all skills in `.agents/skills/` with `openai.yaml`). Our vcontext-based architecture intentionally restricts `.agents/skills/` to `super-skills` only. Full merge would: (1) add redundant `.agents/skills/` filesystem copies of all skills, (2) add simplified `.claude/skills/` builds that conflict with our build process, (3) revert `mcp-server-patterns` to remove our valuable MCP spec content. No upstream adoption.
- **New scripts available**: `check-drift.js`, `install-status.mjs` — evaluated, not adopted (conflict with our build system)

### Action: improved — mcp-server-patterns
- **Source**: MCP official roadmap (modelcontextprotocol.io/development/roadmap, updated 2026-03-05); MCP blog post on stateless HTTP
- **Reasoning**: 2026 roadmap introduces stateless Streamable HTTP design, enterprise readiness patterns (audit trails, SSO, gateway), and Server Cards standard. Our existing skill covers 2025-11-25 spec but was missing 2026 enterprise and transport evolution content.
- **Changes**: Added two new sections — "2026 Roadmap — Stateless Streamable HTTP" (fresh-instance-per-request, session at data model layer, `.well-known` Server Cards) and "2026 Roadmap — Enterprise Readiness" (audit trails, gateway/proxy patterns, SSO-integrated auth, configuration portability)
- **Risk assessment**: low — additive content, no removal of existing patterns

### Action: created — eval-driven-dev
- **Source**: awesome-copilot/skills "Agentic Eval" and "Eval-Driven Dev" patterns; International AI Safety Report 2026 (evaluation gap finding); Addy Osmani LLM coding workflow
- **Reasoning**: Novel gap — none of our existing skills cover LLM output evaluation pipelines. `quality-gate` covers general output review; `tdd-workflow` covers code testing; but no skill addresses: golden dataset creation, evaluator-optimizer pipelines, self-critique loops, or CI eval gates for AI-powered apps. Pattern found in 3+ independent sources. Proven in production AI app development workflows.
- **Changes**: Created `skills/eval-driven-dev/SKILL.md` with workflows for golden dataset creation, evaluator-optimizer pipeline, self-critique loops, and CI gates. Added to `install-components.json`. Added to `super-skills` routing at P5 (dev).
- **Risk assessment**: low — new skill, does not modify existing skills

### Skipped: agent-governance
- **Reasoning**: Covers trust scoring and audit trails for long-running agent deployments. Interesting concept but not actionable as a SKILL.md workflow — too abstract, no concrete step-by-step process. Enterprise audit trail guidance added to `mcp-server-patterns` instead.

### Skipped: graph-based-agents
- **Reasoning**: 3-layer knowledge graph architecture (code/logs/knowledge) for self-improving agents. Novel pattern but requires deep infrastructure changes to implement. Not expressible as a practical SKILL.md workflow at this time.

### Skipped: teams-of-teams (supervisor-worker enhancement)
- **Reasoning**: Addy Osmani's "feature lead spawns specialists" hierarchical delegation is already implicit in our `supervisor-worker` skill's architecture. Adding explicit documentation would be marginally useful but adds noise; the pattern is supported already.

### Step 3: Local AI Model Maintenance
- **MLX generate**: Qwen3-8B-4bit running at port 3162 — confirmed available and healthy
- **MLX embed**: Qwen3-Embedding-8B-4bit-DWQ running at port 3161 — 22,551 embeddings in DB
- **Model research**: Qwen3-14B-4bit and Qwen3-Coder noted as potentially better options (research sources: sitepoint.com, toolhalla.ai)
- **Decision**: No model changes this run — current Qwen3-8B-4bit is stable and performant; upgrade to 14B would require memory budget evaluation. Flagged for manual review.

### Step 4: Hook Auto-Setup
- **Detected tools**: Claude Code, Codex, Cursor, Kiro
- **Hooks installed**: All tools already configured; Codex hooks.json refreshed (backed up previous)
- **No new tools detected** since last run

---

## 2026-04-14 — infrastructure: MLX generate migration (replace Ollama text generation)

### Action: applied
- **Target**: scripts/vcontext-server.js
- **Summary**: Replaced Ollama text generation with MLX generate server (Qwen3-8B-4bit at port 3162, OpenAI-compatible API). Ollama fully removed — MLX now handles both embedding (port 3161) and text generation (port 3162) 24/7 on Apple Silicon GPU.
- **Changes**:
  - Added `MLX_GENERATE_URL` (`:3162`), `MLX_GENERATE_MODEL`, `mlxGenerateAvailable` constants
  - Added `checkMlxGenerate()` — checks `/v1/models` endpoint
  - Added `mlxGenerate(prompt, options)` — OpenAI-compatible `/v1/chat/completions`
  - Replaced all ~12 `ollamaGenerate(model, prompt, options)` call sites with `mlxGenerate(prompt, options)`
  - Removed `ollamaGenerate`, `ollamaEmbed`, `checkOllama`, `pickModel`, `isNightWindow`, `MODEL_PREFS`
  - Removed `OLLAMA_URL`, `ollamaAvailable`, `ollamaModels`, `ollamaPreferredModel` variables
  - Removed all night-window gates on text generation (MLX runs 24/7)
  - Removed Ollama model unload block (`keep_alive: 0`) in discovery loop
  - Simplified embed loop: MLX-only, removed Ollama embed fallback
  - Updated `/health` and `/ai/status` endpoints to report MLX generate status
  - Updated `handleAiSummarize`, completion check, predictive search, discovery loop, auto-skill creation
- **Ollama retained for**: nothing (fully removed)
- **Risk assessment**: medium — all generation now depends on MLX server at port 3162; if unavailable, generation features degrade gracefully (availability checks gate all calls)

---

## 2026-04-14 — infrastructure: better-sqlite3 migration (vcontext-server)

### Action: applied
- **Target**: scripts/vcontext-server.js
- **Summary**: Replaced execFileSync('sqlite3', ...) child-process spawning with in-process better-sqlite3 for all database operations. Eliminates ~18s per search query (child process overhead) down to ~2ms (in-process).
- **Changes**:
  - Added `Database = require('better-sqlite3')` and persistent `ramDb`/`ssdDb` connections via `openDatabases()` (WAL + busy_timeout=5000)
  - `dbExec`: now uses `db.exec(sql)` instead of spawning sqlite3 CLI per write
  - `dbQuery`: now uses `db.prepare(sql).all()` instead of spawning sqlite3 CLI with `-json` flag
  - `doBackup`: uses `ramDb.backup()` (async Promise) with `copyFileSync` fallback
  - `shutdown`: synchronous `copyFileSync` for final backup, closes `ramDb`/`ssdDb` connections
  - Startup: `openDatabases()` called before schema migrations; late `ssdDb` open after `ensureSsdDb` for first-time creation
- **Preserved**: all function signatures, HTTP endpoints, sqlite-vec init, MLX embed code, execSync/execFileSync import (used by non-SQLite shell commands)
- **Risk assessment**: medium — core DB layer change; function interfaces unchanged so rollback is straightforward

---

## 2026-04-14 — infrastructure: MLX embedding migration

### Action: applied
- **Target**: vcontext-server.js, mlx-embed-server.py, launchd plist
- **Summary**: Switched all embedding operations from Ollama (night-only, qwen3-embedding 2048-dim) to MLX (24/7, Qwen3-Embedding-8B-4bit-DWQ 4096-dim on Apple Silicon GPU)
- **Changes**:
  - `handleStore`: embedding via `mlxEmbed()` only, removed Ollama fallback and night-window gate
  - `startEmbedLoop`: MLX-only, runs 24/7 (was Ollama night-only with 30s interval, now MLX 5s interval)
  - `handleSemanticSearch`: MLX-only query embedding, removed Ollama Strategy 2
  - `checkMlx`: fixed health check to accept both `status=healthy` and `status=ok`, reads `model_name` field
  - `doBackupAndMigrate` + startup: embed loop keyed on `mlxAvailable` instead of `ollamaAvailable`
  - Discovery loop: removed Ollama embed model unload (no longer needed)
  - `ai/status` + `/health`: `auto_embed` and `semantic_search` reflect `mlxAvailable`
  - Copied MLX server to permanent path `scripts/mlx-embed-server.py`, fixed uvicorn module resolution
  - Created `scripts/mlx-embed-wrapper.sh` launcher
  - Updated launchd plist `com.vcontext.mlx-embed` to permanent path with `--model 8B`
- **Ollama retained for**: llama3.1 summarize, skill generation, auto-conflict resolution (night window only)
- **Risk assessment**: medium — embedding dimension changes from 2048 to 4096; existing embeddings will be re-generated by the embed loop over time

---

## 2026-04-14 — upstream-sync (run 5)

### Action: skipped
- **Target**: 17 skills (agent-memory, auto-router, confidence-filter, debate-consensus, drift-detect, mcp-server-patterns, model-selector, phase-gate, quality-gate, report-format, research-first, self-evolve, session-handoff, spec-driven-dev, supervisor-worker, ui-implementation, virtual-context)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same regression as prior runs — upstream shows 1,392 deletions, 0 additions. Syncing would destroy all custom orchestration skills including newly added `spec-driven-dev` and `agent-memory`.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-14 — web-discovery (run 5)

**Search window**: 2026-04-13 → 2026-04-14
**Queries executed**: 9
**New sources checked**: 12 (full page fetches via WebSearch + deep dives)
**Candidates found**: 5
**Adopted**: 1 (update) | **Skipped**: 4

### Action: updated — `quality-gate`
- **Source**: agnix (agent-sh/agnix on GitHub; Hacker News "Show HN: Agnix – lint your AI agent configs"; VS Code Marketplace; NPM package `agnix`; skills.pawgrammer.com/skills/agnix)
- **Reasoning**: Agnix is a linter/LSP for AI agent configuration files (CLAUDE.md, AGENTS.md, SKILL.md, hooks, MCP) with 385 rules across Claude Code, Codex CLI, OpenCode, Cursor, Copilot, and more. The key insight from the HN post: **skills invoke at 0% without correct syntax** — e.g. wrong casing in skill name makes it invisible to the auto-router. This is a real problem that `quality-gate`'s completion gate should address. Adding `npx agnix .` as a lint step for agent config changes fills a genuine gap: the existing "run lint: eslint / equivalent" step doesn't cover SKILL.md / CLAUDE.md files. Auto-fix available via `agnix --fix .`.
- **Changes**: Added step 4 to `quality-gate` Completion Gate: "For AI agent config changes (CLAUDE.md, SKILL.md, hooks, MCP): `npx agnix .` — catches syntax errors that silently break skill auto-routing"
- **Risk assessment**: low — documentation/tool reference only; no auto-execution

### Skipped patterns

- **Trellis** (mindfold-ai/Trellis): Multi-platform AI coding workflow CLI with `.trellis/` directory structure (spec/, tasks/, workspace/), parallel agents via git worktrees, and cross-platform entry point generation. Core concepts are already covered: specs → `spec-driven-dev`, parallel agents → `dmux-workflows`, memory/continuity → `session-handoff`, project config → `agent-memory`. Trellis is a tool that *implements* these patterns, not a novel workflow pattern itself.
- **qwen3-coder:30b** (model upgrade): Qwen3-Coder is a 30B-A3B MoE model (3.3B active params, 70%+ SWE-bench Verified) available via `ollama pull qwen3-coder:30b`. Evaluated but not installed — the `code` model in MODEL_PREFS is only used for status reporting (not actual vcontext processing), so the upgrade has no functional impact on the current system. Will reconsider if a code-query endpoint is added to vcontext.
- **Hermes Agent** (Nous Research): Self-improving open-source agent framework (32K+ GitHub stars) with persistent memory, 40+ tools, Atropos RL training loop, and multi-platform messaging (Telegram, Discord, Slack). Platform/framework (not a SKILL.md workflow). The self-improvement concept overlaps `self-evolve`; the persistent memory concept overlaps `virtual-context` + `agent-memory`. Not extractable as a portable workflow.
- **Multi-agent orchestration taxonomy** (Sequential/Pipeline, Orchestration vs Choreography, Hierarchical): Well-documented in multiple sources (Vellum AI, TrueFoundry, Chanl, StackAI). All three patterns are already covered by `supervisor-worker` (hierarchical orchestration) and `dmux-workflows` (parallel execution). No new actionable pattern found.

## 2026-04-14 — local-ai-maintenance (run 5)

### Models updated
- `llama3.1:latest` — pulled, no version change (manifest confirmed)
- `qwen2.5-coder:latest` — pulled, no version change
- `qwen3-embedding:latest` — pulled, no version change

### New model evaluated
- **`qwen3-coder:30b`** — evaluated but not installed. See web-discovery section above.

### Models pruned
- None

### Current model lineup
| Task | Model |
|------|-------|
| summarize | llama3.1:latest |
| embed | qwen3-embedding:latest |
| judge | llama3.1:latest |
| code | qwen2.5-coder:latest (code model only used in status reporting) |

## 2026-04-14 — hook-auto-setup (run 5)

**Tools detected**: Claude Code, Codex, Cursor, Kiro
**Hooks installed/updated**:
- Claude Code — already configured (no change)
- Codex — hooks.json reinstalled
- Cursor — vcontext.json reinstalled
- Kiro — hooks reinstalled

**Validated**: 40 skills, 0 errors. Deployed to `~/.claude/skills/` and `~/.codex/skills/`.

---

## 2026-04-13 — upstream-sync (run 4)

### Action: skipped
- **Target**: 16 skills (agent-memory, auto-router, confidence-filter, debate-consensus, drift-detect, mcp-server-patterns, model-selector, phase-gate, quality-gate, report-format, research-first, self-evolve, session-handoff, supervisor-worker, ui-implementation, virtual-context)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same regression as prior runs — upstream shows 1,272 deletions, 0 additions. Syncing would destroy all custom orchestration skills.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-13 — web-discovery (run 4)

**Search window**: 2026-04-11 → 2026-04-13
**Queries executed**: 9
**New sources checked**: 8 (full page fetches via WebFetch)
**Candidates found**: 6
**Adopted**: 1 | **Skipped**: 5

### Action: created — `spec-driven-dev`
- **Source**: morphllm.com "Spec-Driven Development: How Kiro and AI Agents Build From Specs"; javacodegeeks.com "Spec-Driven Development with AI Coding Agents"; heeki.medium.com "Using spec-driven development with Claude Code"; arxiv 2602.00180 "Spec-Driven Development: From Code to Contract"; Thoughtworks "Spec-driven development — unpacking one of 2025's key engineering practices"; GitHub Spec Kit (84K+ stars, 14+ agent platforms)
- **Reasoning**: Spec-driven development (SDD) is genuinely novel vs existing skills. `plan-architecture` covers technical planning for known requirements; `plan-product` covers product framing. SDD specifically formalizes requirements first via structured spec document (Requirements → Design → Tasks), with explicit acceptance criteria traceability and three levels of rigor (spec-first / spec-anchored / spec-as-source). The key differentiator: the spec serves as both AI guidance and post-implementation verification artifact — preventing agent hallucination drift past ~500 lines. Proven by 2+ independent sources including arxiv paper, Kiro's enforced 3-phase SDLC, GitHub Spec Kit (84K stars), and Thoughtworks analysis.
- **Changes**: Created `skills/spec-driven-dev/SKILL.md` with 3-phase workflow (Requirements/Design/Tasks), three rigor levels table, acceptance-criteria spec format, verification use section, and disambiguation vs plan-architecture. Added to `manifests/install-components.json`, added to `skills-planning` module in `manifests/install-modules.json`, added routing entry (P3 plan, trigger: spec/requirements/acceptance criteria/feature >500 lines) to `skills/auto-router/SKILL.md`.
- **Risk assessment**: low — documentation/workflow skill; no auto-commits; no security implications

### Updated
- `auto-router`: Added routing entry for `spec-driven-dev` at P3 plan
- `manifests/install-components.json`: Added `spec-driven-dev` entry
- `manifests/install-modules.json`: Added `spec-driven-dev` to `skills-planning` module

### Skipped patterns

- `Kiro Powers (dynamic MCP activation)`: POWER.md format for context-aware MCP server activation based on keyword triggers. Novel concept — "mention 'database' and the Neon power activates; switch to deployment and Neon deactivates." However: (1) our `auto-router` already does dynamic skill activation via context triggers; (2) the POWER.md format is Kiro-specific and not portable to a SKILL.md workflow; (3) the underlying concept (activate tools on demand) is covered at the skill level by our routing table. Not extractable as a standalone skill.
- `Kiro Steering vs AgentSkills distinction`: Steering = workspace-specific rules, Skills = portable cross-workspace procedures. Already covered by our CLAUDE.md / SKILL.md separation. Not novel enough to justify a new skill.
- `AI Agent Prompt Patterns (CRISP, Chain of Verification, etc.)`: 10 patterns from paxrel.com. Patterns 1-5 (role+constraints, structured output, error recovery, tool heuristics) are basic prompt engineering covered by existing skills. Patterns 6/8/9 (context window management, progressive disclosure, memory integration) overlap `virtual-context`, `phase-gate`, and `agent-memory`. No novel standalone skill extractable.
- `Bounded Autonomy governance pattern`: Governance framework for production AI agents — operational limits, escalation paths, audit trails. Conceptually sound but: (1) enterprise governance, not a coding-agent workflow; (2) our `guard`/`careful`/`freeze` safety skills already encode operational limits; (3) escalation is covered by `supervisor-worker`. Not actionable as a SKILL.md workflow.
- `Parallel Model Execution` (Cursor): Run same prompt across multiple models simultaneously and compare. Covered in spirit by `debate-consensus` and `model-selector`. Implementation is Cursor-specific (UI side-by-side comparison). Not extractable without Cursor-specific infrastructure.

## 2026-04-13 — local-ai-maintenance (run 4)

### Models updated
- `llama3.1:latest` — pulled, no version change (manifest confirmed)
- `qwen2.5-coder:latest` — pulled, no version change
- `gemma:2b` — pulled, no version change
- `glm-4.7-flash:latest` — pulled, no version change

### New model installed
- **`nomic-embed-text:latest`** (137M, Apache 2.0, purpose-built embedding model)
  - **Reason**: Current embed model `gemma:2b` is a general-purpose chat model not optimized for embeddings. `nomic-embed-text` is purpose-built for semantic similarity with 768-dim vectors, listed as top embedding choice for RAG on Apple Silicon in 2026 benchmarks. Available via `ollama pull`. Size: 137M — much lighter than gemma:2b.
  - **Change**: Updated `MODEL_PREFS.embed` in `vcontext-server.js` to `['nomic-embed-text', 'gemma', 'llama3.1', 'qwen2.5-coder']`. Reloaded vcontext server. Confirmed active via `/ai/status`: `"embed": "nomic-embed-text:latest"`.
  - **Risk assessment**: low — fallback to gemma retained in prefs list

### Models pruned
- None (gemma:2b retained as fallback)

### Current model lineup
| Task | Model |
|------|-------|
| summarize | llama3.1:latest |
| embed | nomic-embed-text:latest ← upgraded |
| judge | llama3.1:latest |
| code | qwen2.5-coder:latest |

## 2026-04-13 — hook-auto-setup (run 4)

**Tools detected**: Claude Code, Codex, Cursor, Kiro
**Hooks installed/updated**:
- Claude Code — already configured (no change)
- Codex — hooks.json reinstalled (backed up existing)
- Cursor — vcontext.json reinstalled
- Kiro — hooks newly installed at `~/.kiro/hooks/`

**Note**: Kiro was newly detected this run — hooks installed for the first time.

**Validated**: 40 skills, 0 errors. Deployed to `~/.claude/skills/` and `~/.codex/skills/`.

## 2026-04-11 — upstream-sync (run 3)

### Action: skipped
- **Target**: 14 skills (auto-router, confidence-filter, debate-consensus, drift-detect, mcp-server-patterns, model-selector, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation, virtual-context)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same regression as prior runs — upstream shows 1,067 deletions, 0 additions. Syncing would destroy all custom orchestration skills.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-11 — web-discovery (run 3)

**Search window**: 2026-04-11 → 2026-04-11
**Queries executed**: 10
**New sources checked**: 10 (full page fetches via WebFetch)
**Candidates found**: 8
**Adopted**: 2 | **Skipped**: 6

### Action: created — `agent-memory`
- **Source**: tessl.io "From Prompts to AGENTS.md" (2026); arxiv 2601.20404 "On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents"; Addy Osmani "Code Agent Orchestra"; DEV Community "AI Agent Memory Management — When Markdown Files Are All You Need"; O'Reilly "Why Multi-Agent Systems Need Memory Engineering"
- **Reasoning**: Hierarchical AGENTS.md pattern (root → component → tool, with parent-rule inheritance) is genuinely novel vs existing skills: `session-handoff` handles within-session state recovery; `virtual-context` uses SQLite/RAM store; our personal MEMORY.md is cross-project personal memory. AGENTS.md is project-level, git-native, shared institutional knowledge with a meta-learning feedback cycle. Proven by arxiv research: 28.64% runtime reduction, 16.58% output token reduction. Key distinction: LLM-generated rules show no benefit — human approval required for all additions.
- **Changes**: Created `skills/agent-memory/SKILL.md` with session-start workflow (hierarchical read), failure/success workflows (propose → human approves → write), AGENTS.md format template, and research notes. Added to `manifests/install-components.json`, added to `skills-orchestration` module in `manifests/install-modules.json`, added routing entry (P6 patterns, trigger: AGENTS.md/new project/institutional memory) to `skills/auto-router/SKILL.md`.
- **Risk assessment**: low — read-heavy workflow; never auto-writes AGENTS.md; all writes require human approval

### Action: updated — `mcp-server-patterns`
- **Source**: MCP Roadmap 2026-03-05 (modelcontextprotocol.io); MCP Tasks primitive SEP-1686; Server Cards specification
- **Reasoning**: Two new MCP primitives not yet documented in the skill: (1) Tasks primitive (SEP-1686) — call-now/fetch-later pattern for async long-running operations, now in production use and surfacing retry/expiry gaps; (2) Server Cards — `.well-known/mcp-server-card.json` format for client/registry capability discovery without connecting. Both are newer than the 2025-11-25 spec already covered in the skill.
- **Changes**: Added Tasks Primitive section (design pattern, retry semantics, expiry policy) and MCP Server Cards section (format, `.well-known/` URL, lightweight metadata guidance).
- **Risk assessment**: low — documentation only

### Updated
- `auto-router`: Added routing entry for `agent-memory` at P6 patterns
- `manifests/install-components.json`: Added `agent-memory` entry
- `manifests/install-modules.json`: Added `agent-memory` to `skills-orchestration` module

**Validated**: 38 skills, 0 errors. Deployed to `~/.claude/skills/` and `~/.codex/skills/`.

### Skipped patterns

- `shared-task-manifest` (Addy Osmani "Code Agent Orchestra"): Parallel agent coordination via explicit task list with pending/in_progress/completed/blocked statuses. Novel aspect (explicit dependency chains and peer-to-peer unblocking) is partially covered by `supervisor-worker` + `dmux-workflows`. Not found in 2+ independent sources as a distinct, proven workflow.
- `context-reset-loop` / Ralph Loop (Osmani): Atomic commit cycle — pick task, implement, validate, commit, reset context. Context management aspect partially covered by `virtual-context`. The "reset after each commit" is basic git hygiene rather than a novel skill workflow. Not proven enough as standalone pattern.
- `squad-drop-box` (GitHub Squad): Repository-native multi-agent coordination via `decisions.md` drop-box file + `.squad/` charter files. Interesting architecture but (a) Squad-platform-specific, (b) covered in spirit by `session-handoff` + `supervisor-worker`, (c) no implementation-agnostic SKILL.md workflow extractable.
- `subagent-lifecycle-hooks`: Claude Code SubagentStart/SubagentStop hooks for event-driven coordination (Slack notifications, log aggregation). Too narrow and implementation-specific. `update-config` already covers hook setup; specific event names can be added there if needed.
- `mcp-server-cards-standalone`: Server Cards are documented in `mcp-server-patterns` update above. Not worth a separate skill.
- `memory-engineering-5-pillars` (O'Reilly): Taxonomy (working/episodic/semantic/procedural/shared), persistence, retrieval, coordination, consistency. Conceptually rich but too abstract/architectural for a concrete SKILL.md workflow. Better as documentation than a repeatable agent skill.

---

## 2026-04-10 — upstream-sync

### Action: skipped
- **Target**: 8 skills (auto-router, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Diff shows upstream does NOT have these orchestration skills (they are local additions). Additionally, all upstream `.agents/skills/*/agents/openai.yaml` files have regressed `short_description` to literal `"|"` — a clear upstream bug. Syncing would remove our orchestration skills and corrupt agent YAML metadata.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-10 — web-discovery

### Action: created
- **Target**: `debate-consensus`
- **Source**: Beam AI "9 Best Agentic Workflow Patterns 2026", Vellum AI "Emerging Architectures", ByteByteGo "Top AI Agentic Workflow Patterns"
- **Reasoning**: Multi-agent adversarial deliberation pattern is genuinely novel vs existing skills. `supervisor-worker` is hierarchical delegation; `debate-consensus` is structured disagreement before a decision. Multiple reputable 2026 sources confirm this as an emerging best practice. Safe (no destructive actions, no telemetry). Fills gap for high-stakes architecture/tradeoff decisions.
- **Changes**: Created `skills/debate-consensus/SKILL.md`, added to `manifests/install-components.json`, added to `skills-orchestration` module in `manifests/install-modules.json`, added routing entry to `skills/auto-router/SKILL.md`. Validated (33 skills, 0 errors), deployed to `~/.claude/skills/` and `~/.codex/skills/`.
- **Risk assessment**: low

### Skipped patterns
- `self-validate-output`: Overlaps significantly with `verification-loop`. The auto-regenerate nuance is marginal.
- `exploit-confirm`: Requires explicit authorization scoping; too risky without user-defined sandbox constraints.
- `hook-enforcement`: More of a one-time project setup than a repeatable skill workflow. `update-config` skill covers adjacent ground.
- `session-scoped-auth`: Conceptual MCP governance pattern, not actionable as a SKILL.md workflow.

---

## 2026-04-11 — upstream-sync

### Action: skipped
- **Target**: 9 skills (auto-router, debate-consensus, phase-gate, quality-gate, report-format, self-evolve, session-handoff, supervisor-worker, ui-implementation)
- **Source**: takurot/super-skills upstream/main
- **Reasoning**: Same as 2026-04-10 — upstream diff shows only deletions (631 lines removed, 0 added). Upstream does not have our orchestration skills; syncing would destroy them. The upstream YAML regression (`short_description: "|"`) persists. Skip remains protective.
- **Changes**: None applied
- **Risk assessment**: low (skip was protective)

## 2026-04-11 — web-discovery

**Search window**: 2026-04-10 → 2026-04-11
**Queries executed**: 6
**New sources checked**: 12 (full page fetches via WebFetch)
**Candidates found**: 8
**Adopted**: 0 | **Skipped**: 8 | **Flagged**: 0

### Action: skipped (all candidates)

**Sources searched:**
- "Claude Code skills new 2026" — [MindStudio](https://www.mindstudio.ai/blog/claude-code-5-workflow-patterns-explained), [Medium unicodeveloper](https://medium.com/@unicodeveloper/10-must-have-skills-for-claude-and-any-coding-agent-in-2026-b5451b013051)
- "agentic workflow patterns 2026" — [Vellum AI](https://www.vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns), [StackAI](https://www.stackai.com/blog/the-2026-guide-to-agentic-workflow-architectures)
- "AI agent orchestration patterns 2026" — [StartupHub.ai](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/multi-agent-orchestration-patterns), [Catalyst & Code](https://www.catalystandcode.com/blog/ai-agent-orchestration-frameworks)
- "MCP new servers April 2026" — [MCP Blog](https://blog.modelcontextprotocol.io/), [The New Stack](https://thenewstack.io/model-context-protocol-roadmap-2026/)
- "AI agent safety patterns 2026" — [QueryPie](https://www.querypie.com/features/documentation/white-paper/28/ai-agent-guardrails-governance-2026), [Authority Partners](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/)
- "github awesome claude code agent skills 2026" — [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code), [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)

**Skipped patterns:**
- `hierarchical-multi-agent`: Identical to `supervisor-worker` — "supervisor delegates to specialist workers." No new workflow steps.
- `decentralized-swarm`: Peer agents converging via rules/time limits. Covered by `debate-consensus` (structured adversarial deliberation before decisions). Swarm adds no actionable workflow difference.
- `sequential-pipeline-with-hard-checks`: "Each step measurable, testable, cost predictable." Fully covered by `quality-gate` + `phase-gate` combination.
- `sandbox-isolation-branch-per-agent`: Containerized parallel agents returning branches for review. Conceptually interesting; partially covered by `dmux-workflows` + worktree isolation. Not yet a proven repeatable SKILL.md pattern — more of a platform feature than a skill workflow.
- `autonomy-spectrum-selection`: Progressive human oversight (in-loop → on-loop → out-of-loop) based on task risk. Conceptually novel but not yet proven as a concrete, repeatable workflow in multiple sources. Worth monitoring.
- `dual-log-audit-trail`: Action log + rationale log with hash chain. Covered by `report-format` + `checkpoint` combined.
- `kill-switch-escalation`: Three-level graduated stops. Covered by `guard` + `careful` combined.
- `domain-specific-agent-team-generator`: Meta-agents that design other agent architectures. Speculative and unproven; no implementation details found.

**Note**: The 1-day freshness window (2026-04-10 → 2026-04-11) yielded limited truly new content from broad pattern searches. However, deep-fetching of specific GitHub repositories (awesome-claude-code, AgentSys, claude-code plugins) surfaced genuinely novel implementation-level patterns not covered by prior searches.

---

## 2026-04-11 — adoptions (web-discovery follow-up)

**Search window**: 2026-04-10 → 2026-04-11 (continued from web-discovery above)
**New sources deep-fetched**: 8 (GitHub repos via WebFetch)
**Candidates adopted**: 3 new skills + 1 skill update

### Action: created — `drift-detect`
- **Source**: AgentSys (avifenesh/agentsys), validated on 1,000+ repositories with 77% token reduction reported
- **Reasoning**: Tiered-certainty analysis (deterministic→LLM escalation) is genuinely novel vs `health-check` (binary pass/fail) and `verification-loop` (iterate until passing). The key insight — run grep/regex/AST first, escalate to LLM only for MEDIUM/LOW certainty findings — reduces cost significantly and is missing from all existing skills.
- **Changes**: Created `skills/drift-detect/SKILL.md` with 5-phase workflow, certainty tier definitions, deterministic rule templates, and token efficiency reporting.
- **Risk assessment**: low — deterministic-first, LLM only for advisory; no auto-actions

### Action: created — `model-selector`
- **Source**: AgentSys + multiple 2026 community sources on Plan-and-Execute with Model Tiering
- **Reasoning**: No current skill addresses explicit Claude model-tier assignment before launching agents. The Haiku/Sonnet/Opus decision matrix (mechanical→Haiku, coverage/review→Sonnet, architecture/planning→Opus) is proven and actionable via the Agent tool's `model` parameter. Can reduce costs by up to 90% vs Opus-for-everything.
- **Changes**: Created `skills/model-selector/SKILL.md` with decision matrix, task→model mappings table, and integration guidance.
- **Risk assessment**: low — guidance only, no auto-actions

### Action: created — `confidence-filter`
- **Source**: claude-code plugins/code-review pattern, AgentSys 6-agent parallel domain-specialist review
- **Reasoning**: Distinct from `debate-consensus` (which reaches a decision through adversarial deliberation) and `review` (single agent). `confidence-filter` is specifically for suppressing false positives from parallel reviewer agents via vote-threshold aggregation. Multiple sources confirm this pattern for high-noise review environments.
- **Changes**: Created `skills/confidence-filter/SKILL.md` with voting aggregation formula, threshold calibration guidance, dimension templates for code review, and escalation rules for critical findings.
- **Risk assessment**: low — aggregation and filtering only; never suppresses critical findings below threshold unconditionally

### Action: updated — `mcp-server-patterns`
- **Source**: modelcontextprotocol.io specification 2025-11-25
- **Reasoning**: Three new primitives (Elicitation, Roots, Sampling) added to official MCP spec are not documented in the existing skill. The tool-annotation trust boundary clarification ("untrusted unless from trusted server") is also new and security-relevant.
- **Changes**: Added Elicitation, Roots, Sampling primitive descriptions with safety notes; added trust boundary update for tool annotations.
- **Risk assessment**: low — documentation only

### Updated
- `auto-router`: Added routing entries for `drift-detect`, `model-selector`, `confidence-filter`
- `manifests/install-components.json`: Added 3 new skill entries
- `manifests/install-modules.json`: Added 3 new skills to `skills-orchestration` module

### Validation & Deploy
- `node scripts/validate-skills.js`: 36 skills, 0 errors, 0 warnings
- Deployed to `~/.claude/skills/` (36 skills) and `~/.codex/skills/` (36 skills)

### Skipped patterns from second-agent batch
- `autonomous-loop` (Ralph Wiggum): Novel bash-restart-from-known-state pattern. Promising but single source (ClaytonFarr/ralph-playbook) with limited independent validation. Monitor for future runs.
- `team-architect` (revfactory/harness): Meta-skill for auto-generating agent team structures. Genuinely novel but complex and speculative — risk of encouraging over-engineering. Revisit when more real-world adoption evidence exists.
- `adaptive-guard` (hookify): Dynamically generates behavioral rules from AI misbehavior. Interesting but single source; rule-generation without human review could undermine predictable safety behavior. Skip.
- `codebase-context` (Claudekit): Auto-inject architecture map at session start. Covered adequately by `session-handoff`. Not a standalone skill pattern.
- `autonomy-spectrum-selection`: Appears in multiple sources but lacks concrete, repeatable workflow steps. Watch for future runs.

## 2026-04-16 — auto (maintenance)
- Discovery: 18 searches | Suggestions: 68 | Skills created: 68
- Embedding: 23165/34438 | Sessions: 67
- Upstream: 0 commits behind

## 2026-04-16 — auto (maintenance)
- Discovery: 20 searches | Suggestions: 67 | Skills created: 76
- Embedding: 24586/34473 | Sessions: 62
- Upstream: 0 commits behind

## 2026-04-16 — auto (maintenance)
- Discovery: 20 searches | Suggestions: 71 | Skills created: 76
- Embedding: 25632/34899 | Sessions: 62
- Upstream: 0 commits behind

## 2026-04-18 — evolution-cycle 2026-16

**Type**: evolution-cycle (weekly scheduled)
**Weights used**: w1=0.25, w2=0.25, w3=0.2, w4=0.2, w5=0.1
**Candidates gathered**: total=0, by source={}
**Top-K scored**: 0
**Pending-patches emitted**: 0
**Observation mode**: yes
**Notes**: observation mode: Phase (c)-(e) skipped

## 2026-04-19 — evolution-cycle 2026-16

**Type**: evolution-cycle (weekly scheduled)
**Weights used**: w1=0.25, w2=0.25, w3=0.2, w4=0.2, w5=0.1
**Candidates gathered**: total=0, by source={}
**Top-K scored**: 0
**Pending-patches emitted**: 0
**Observation mode**: yes
**Notes**: observation mode: Phase (c)-(e) skipped

## 2026-04-20 — manual milestone (Stage 4.5 + SKAP v1)

**Type**: milestone (hand-authored, see `git log --since='2026-04-20 00:00'`)
**Commits**: 49 (morning cascade + diagnosis + Stage 1-4.5 + SKAP v1 A/B/C/D/F)

**Shipped infrastructure**:
- Stage 4.5: 9 of 10 commits (C9 H3 pending for 2026-04-21)
  - /admin/vacuum (size-guarded)
  - /admin/auto-tune + /admin/snapshot
  - /admin/metrics/window + /admin/gc/dry-run + /admin/policy-check
  - /admin/verify-backup offloaded to worker_thread (AC-4 PASSED:
    20000 ms → 1 ms concurrent /health during verify)
  - /admin/db-size (C7b bonus)
  - /store content-type validation + [object Object] boot-sweep (C10)
  - maintenance.sh + self-improve.sh + abtest.sh HTTP cutover
  - hooks.js cmdSnapshot + cmdMetrics + cmdPolicyCheck HTTP cutover
- SKAP v1: 5 of 6 phases
  - /aios/bootstrap (A) with ETag + If-None-Match + format=system-prompt
  - SessionStart hook auto-injection (B)
  - /aios/mcp-manifest (C) — 4 tool defs for cross-AI clients
  - docs/runbooks/skap-cross-machine.md (D) — Tailscale + ssh -L
  - /admin/kb-diff (F) — CLAUDE.md ↔ vcontext drift detector
- check-openapi-sync.mjs — AC-8 verifier (ENDPOINTS_LIST ↔ YAML ↔ handlers)

**Evidence-based corrections** (logged as vcontext lesson-learned):
- 224681 dramatic-diagnosis (36 GB ceiling was wrong)
- 224682 self-congratulatory framing (backup extraction ≠ 疎結合)
- 224683 stale price claim (SSD ¥25k → ¥65k)
- 224684 dismissive negation (AIOS 通報 id=224423 existed)

**New principles**:
- docs/principles/AIOS-CONSTITUTION.md (4 axioms + 6 principles + HITL)
- docs/principles/shared-knowledge-source-of-truth.md (SKAP C1-C5)

**Stability impact**:
- SIGKILL-137 count: 117 (start of day) → 126 (end) — 9 were
  controlled restarts during testing, not organic crashes
- WAL size: stable at 2-3 MB throughout
- primary.sqlite: 6.5 GB stable, no runaway
- Worker_thread offload (C5) produced the biggest UX signal:
  /admin/verify-backup concurrent /health latency dropped 4 orders
  of magnitude

**Notes**: the human operator pushed the session well past
end-of-day multiple times with "まだ進めたい / 続けてください";
evidence-before-claim discipline (3-tool trigger rule) and
TDD RED→GREEN on every endpoint kept the 49-commit day free of
regression noise. Three HITL cycles (C9 H3 pending, SKAP Phase E
deferred, Qwen3.6-35B decision deferred) show the co-evolution
pattern from Constitution Axiom 4 working as designed.

## 2026-04-20 — evolution-cycle 2026-16

**Type**: evolution-cycle (weekly scheduled)
**Weights used**: w1=0.25, w2=0.25, w3=0.2, w4=0.2, w5=0.1
**Candidates gathered**: total=5, by source={"self_improve":5}
**Top-K scored**: 3
**Pending-patches emitted**: 0
**Observation mode**: yes
**Notes**: observation mode: Phase (c)-(e) skipped

## 2026-04-21 — Session 905f38bd (evening emergency recovery + AIOS clarification)

**Type**: emergency-recovery + stability-migration

**Shipped**:
- H10+H12 root cause definitively identified (wrapper.sh:99-100 `wait_server_bound` 120s timeout, triggered by 9 GB DB slow startup + hourly backup contention)
- `scripts/migrations/embedding-json-to-blob.mjs` + reverse — 103,485 rows migrated, 1,783 skipped (768-dim legacy, separately NULL-swept for re-embed)
- Commit 21210f8 — POST /store 1 MiB content size guard (fts5 corruption defense)
- Commit 5321311 — BLOB migration + decodeEmbedding helper (7 call sites updated)
- VACUUM: primary 8.54 → 3.55 GB, ssd 8.60 → 3.55 GB
- Disk recovery: +40 GiB (corrupt orphans + old snapshots + premigration + stale backups)
- com.vcontext.backup restored; first post-fix cycle: 3.55 GB in 30.5s, integrity ok, zero crash

**Key decisions**:
- L2 loop memory gate: SKIP (Agent 3 re-run verdict; backup was the real trigger)
- Devin-style integration path: A (AIOS 内製 via claude-api + task-runner + SKAP)
- AIOS principle clarified: local is a phase, not a rule (memory recorded)

**Crash count**: 6 SIGKILL-137 (all pre-cleanup or during VACUUM transition); steady state post-cleanup = 0

**Next session**: see `docs/handoff/2026-04-22-next-session-kickoff.md`

## 2026-04-21 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3269/4699 | Sessions: 48
- Upstream: 0 commits behind

## 2026-04-21 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3134/4576 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3133/4588 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3133/4602 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3134/4612 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3132/4619 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3133/4633 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3134/4654 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-21 — evolution-cycle 2026-16

**Type**: evolution-cycle (weekly scheduled)
**Weights used**: w1=0.25, w2=0.25, w3=0.2, w4=0.2, w5=0.1
**Candidates gathered**: total=7, by source={"self_improve":7}
**Top-K scored**: 3
**Pending-patches emitted**: 0
**Observation mode**: yes
**Notes**: observation mode: Phase (c)-(e) skipped

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3135/4657 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3134/4669 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 5 | Skills created: 0
- Embedding: 3134/4688 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 4 | Skills created: 0
- Embedding: 3116/4681 | Sessions: 47
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 4 | Skills created: 0
- Embedding: 3504/5083 | Sessions: 48
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 8 | Skills created: 0
- Embedding: 3753/5338 | Sessions: 49
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 8 | Skills created: 0
- Embedding: 3839/5434 | Sessions: 49
- Upstream: 0 commits behind

## 2026-04-22 — auto (maintenance)
- Discovery: 0 searches | Suggestions: 9 | Skills created: 0
- Embedding: 3952/5579 | Sessions: 48
- Upstream: 0 commits behind

## 2026-04-22 — Session 905f38bd→28d38f34 (MLX observability + "zero error rate" pursuit)

**Type**: stability-observability + memory-hygiene verification

**Shipped** (7 commits):
- e7813dc — Check #8 launchd service health (detectAnomalies)
- e75da6e — RAM/SSD gap excludes SKIP_TYPES
- fc1094e — RTOS cycle duration + jitter (D1)
- 97ad526 — 3-tier probes /live /ready /startup (D2)
- 39bbaee — MLX keep-alive probe + latency instrumentation
- 95674e3 — keep-alive 30s→10s
- 5f6ed4a — new-feature-watcher graceful skip (A-alt)
- 0486713 — maintenance.sh SKILLS_DIR ordering fix

**Key findings**:
- jetsam priority 40 is IMMUTABLE for user LaunchAgents
  (plist key silently ignored, confirmed by live test)
- Keep-alive w/ same-text probe hits MLX cache → 500× latency improvement
- MLX 3.4GB model gets swapped under daytime pressure (RSS 250MB-3.4GB osc.)
- mlx-embed-server.py already state-of-art for user-space
  (clear_cache + gc.collect + set_cache_limit all present)

**Decisions**:
- A-alt for new-feature-watcher (no API key, graceful skip, exit 0)
- Overnight-drain strategy (day=accept slow, night=natural drain)
- Don't lower keep-alive below 10s (withMlxLock pressure)

**Next**: backup exit=52 + conversation-skill-miner exit=1 triage,
then optionally (4) Model pre-load.
