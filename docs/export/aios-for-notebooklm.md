# AIOS — 全体像 (NotebookLM 取り込み用 2026-04-20 版)

このドキュメントは AIOS を NotebookLM などの外部 AI / 検索ツールに読ませ、第三者視点で対話・質問・要約できるようにするための単体完結説明です。固有名詞と数値は事実ベース。2026-04-20 時点のスナップショット。

---

## TL;DR

AIOS (AI Operating System) は、Claude・Codex・自律エージェント群 が「使う側」である前提で設計された独立プロセスの集合体。UNIX 的な **小さな部品 + 明示的な contract + 疎結合** を原則にし、記憶・埋め込み・生成・監視・自己修復をすべて HTTP と JSON でやり取りする。現状、Mac 1 台 (MacBook Pro M3 Pro 36 GB) 上の launchd で動作し、プロセス数 約 8 個、ポート帯 3150-3499、総 commit 数 今日だけで 29。

ユーザー (=人間) は administrator ではなく **first-class participant**。意思決定は人間、実装は AI、観察と評価は両者、という HITL (Human-In-The-Loop) 規約で動く。

---

## 1. AIOS が「何でないか」で定義する

| ❌ これではない | ✅ これが AIOS |
|---|---|
| SaaS プロダクト | 自分たちが唯一のユーザーである運用システム |
| チャットボットのラッパー | OS (supervisor + プロセス群 + ファイルシステム + HTTP コンタクト) |
| 単一言語で書かれたモノリス | contract が正、言語は交換可能 (TS/Python/Rust/Bash 併用) |
| 完成品 | 絶え間なく進化する基盤 (1.0 ship 予定なし) |
| 一方的な自動化 | AI と人間の対話による共進化 |

---

## 2. Four Axioms (AIOS Constitution より)

**Axiom 1 — AIOS is an OS.**
アプリでもツールでもない。supervisor + 独立プロセス群 + プロセス間 contract (HTTP endpoints) から成る OS。

**Axiom 2 — AIOS is an OS for AI.**
一次ユーザーはキーボードの前の人間ではなく Claude / Codex / self-evolve loop などの AI。インターフェースは machine-readable first, human-readable second で設計する。

**Axiom 3 — AI itself evolves AIOS.**
自己改変は first-class。`/admin/task-request`、self-evolve サイクル、skill-discovery、keyword-expander がカーネルの進化機構。**コードはデータ、提案はエントリ、変更はすべて自分が生みだした substrate に記録される**。

**Axiom 4 — AIOS co-evolves with us.**
人間と AI の partnership。人間が方向を決め、AI が実装・観察・提案する。どちらも単独で再設計はしない。

---

## 3. Six Architectural Principles

### P1 — Loose coupling over monoliths
すべての主要関心事を独立したプロセスに分離する: `com.vcontext.server` / `mlx-embed` / `mlx-generate` / `backup` / `watchdog` / `task-runner` / `maintenance`。各々に独立した plist / log / fail-recovery。ある部品のバグが別の部品の死に連鎖しない。

*歴史的教訓 2026-04-20*: `doBackup()` を server のイベントループ内に埋め込んでいた結果、SIGKILL カスケードで 28 GB の runaway WAL が発生。バックアップ別プロセス化で根治。

### P2 — Contract-first over language-first
基盤は言語ではない。HTTP エンドポイント、ファイルパス、JSON 形状、イベントストリームが基盤。**contract を正しくすれば、言語は交換可能**。オーケストレーションは TypeScript/Bun、ML は Python、ホットパスは Rust/Go、シェル糊は Bash。

### P3 — Fail-open for infra, fail-closed for policy
vcontext 自体がダウンしていたらフック呼び出しは pass させる (fail-open、インフラ痛みを増やさない)。スキル未使用での書き込み試行なら block (fail-closed、ポリシーは守る)。2026-04-20 朝の cascade は `get()` が fail-closed すべきでない状況で fail-closed した事が一因。

### P4 — Machine-readable logs / metrics / contracts
すべての substrate アクションは構造化イベント (JSONL) を出す。すべての API はスキーマを持つ (OpenAPI 3.1 / JSON Schema)。contract は `docs/schemas/` か inline `// @schema` コメントに。**口伝で運用しない**。

### P5 — Reversibility by default
git commit は粒度を細かく。破壊的操作 (delete, force-push, migrate) は明示的確認を通す。バックアップは 15 分ごと。`.bak` は最後の手段として神聖化される。

### P6 — Observe before act
バグは仮説 → ランタイム証拠で検証 → 修正、の順。推測修正 (speculative fix) はしない。`investigate` スキルは装飾ではなく必須。2026-04-20 の 28.77 GB WAL は「もっと強く再起動すれば直る」発想では発見できなかった事例。

---

## 4. HITL Protocol (人間と AI の役割分担)

| Tier | 定義 | 例 |
|---|---|---|
| **H1 — Autonomous** | AI 単独実行 (任意で通知) | バグ修正(根本原因明確な場合)、watchdog patch、ログ掃除、docs 更新、reversible な単一 commit |
| **H2 — Propose-then-execute** | AI 提案 → 人間承認 → AI 実行 | 新規 LaunchAgent、schema migration、ライブサービス再起動、2 案以上あるデザイン選定 |
| **H3 — Propose-and-wait** | AI 提案 → 人間決定 → AI 実装 | 言語選定、プライバシー方針、外部 API 契約、不可逆データ操作、「AIOS の形」が変わる変更 |
| **H4 — Stop and escalate** | 止まって人間に報告 | 本番パスのセキュリティ脆弱性、データ破損、プライバシー漏洩リスク、セッション範囲外の操作、H1-H4 判断自体が不明なとき |

原則: **迷ったら 1 ランク上にエスカレート**。

---

## 5. 構成プロセス (2026-04-20 時点の実態)

| プロセス | plist 名 | ポート | 役割 |
|---|---|---|---|
| **vcontext server** | `com.vcontext.server` | **3150** | 記憶ストア (SQLite)。`/store` `/recall` `/recent` `/admin/*` を提供。全ての共有知が入る中核 DB (現在 6.7 GB / 135k エントリ) |
| **MLX embed** | `com.vcontext.mlx-embed` | **3161** | Qwen3-Embedding-8B-4bit-DWQ。4096 次元埋め込み |
| **MLX generate** (proxy) | `com.vcontext.mlx-generate` + `com.vcontext.mlx-generate-proxy` | 3162/**3163** | 8B LLM。現在 Stage 4.5 完了まで disabled。proxy 側にメモリ圧ゲート+lazy-load 機構 |
| **backup** | `com.vcontext.backup` | — | 15 分毎 `.backup()` スナップショット、HTTP thin-client 経由 |
| **watchdog** | `com.vcontext.watchdog` | — | プロセス生存監視、MLX メモリ圧再起動、WAL チェックポイント |
| **maintenance** | `com.vcontext.maintenance` | — | 定期メンテ (integrity check, vacuum, auto-tune) |
| **task-runner** | `com.vcontext.task-runner` | — | `/admin/task-request` ジョブ実行 |
| **dashboard** | (server 同居) | 3150 | ブラウザ UI (/dashboard) |

### 外部システム連携

| 外部 | ポート | 用途 |
|---|---|---|
| **SearXNG** (Docker) | 8888 | 複数エンジン集約検索。時刻鋭敏な事実確認 (Verify-Before-Assert) で必須 |
| **Anthropic Claude** | — | 主要 AI クライアント。Claude Code / API 経由 |
| **NotebookLM / 他 AI** | — | 未接続 (SKAP Phase C で対応予定) |

---

## 6. Skills 体系 (AIOS が提供する AI 向けガイドライン)

`~/skills/skills/*` に 76 個以上のスキルが格納されている。各スキルは SKILL.md を持ち、以下のメタデータで管理:

- `name`: スキル ID
- `description`: いつ使うか
- `origin`: `unified` (人間キュレーション) / `auto-generated` (discovery 生成)
- `P0-P3`: 優先度。P0 は常時マッチ候補

**P0 always スキル** (抜粋):
- `virtual-context`: セッション/意思決定/複雑問い合わせ (※ 2026-04-20 現在 SKILL.md 実体不在、SKAP で修正予定)
- `supervisor-worker`: multi-agent オーケストレーション
- `quality-gate`: 成果物品質判定
- `report-format`: 完了報告フォーマット
- `phase-gate`: フェーズ遷移
- `session-handoff`: セッション開始時
- `self-evolve`: 更新時

**Routing**: `infinite-skills` スキルが UserPromptSubmit フックで発火し、ユーザー発話をトリガーキーワードと照合してマッチしたスキルを context に注入する。

**AIOS-connected 作業の MANDATORY 規則**: AIOS 関連ファイル (`~/skills/**`, `com.vcontext.*`, RAM disk, vcontext API, MLX, SearXNG, skill 各種) を触る作業では、毎 exchange 毎に `infinite-skills` を再コンサルトし、マッチしたスキルは「適用 or 不適用の理由ログ」を残すこと。サブエージェント呼び出しにも同じ規則を伝播させる。

---

## 7. 2026-04-20 当日の進化 (29 commits)

### 朝 — OOM cascade からの復旧
- 3 つの morning bugs 修正 (cap / hook / AIOS-gate L142)
- watchdog の cold-boot grace 追加
- MLX メモリ圧検知で再起動

### 午前 〜 午後 — 真の疎結合への旅 (Stage 1-4)
朝時点では backup を server プロセス内で `doBackup()` していた → イベントループ block → SIGKILL → runaway WAL。

| Stage | 内容 | Commit |
|---|---|---|
| 1 | backup を別プロセスに分離 | `fe1c0c1` |
| 2 | `/admin/integrity-check` 新設 (maintenance.sh を thin-client 化) | `f8670eb` |
| 3a | `/admin/backup` 新設 + boot-sweep (5.28 GB 孤児 .tmp 発見) | `2e17637` |
| 3b | `vcontext-backup.sh` を 227 → 91 LOC の HTTP thin-client 化 | `ca27712` |
| 4 | `/admin/wal-checkpoint` 新設 + UC1 時間毎 VACUUM 削除 (TDD RED→GREEN) | `16e3f6b`+`884cc0b` |

### 夕方 — Stage 4.5 spec 作成
20-caller audit で、Stage 1-4 で解決できていない残 19 callers を発見。すべての primary.sqlite アクセスをサーバープロセス内に閉じ込める総仕上げ spec を 671 行で作成。10 commits 計画 (C1-C10)。

### 夜 — 共有知層の構築
ユーザー指摘「CLAUDE.md だと環境依存、他 AI 使えない」を受けて:
- `docs/principles/shared-knowledge-source-of-truth.md` (vcontext が真の source、CLAUDE.md は cache)
- `docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md` (SKAP v1 仕様)
- vcontext に 4 lesson-learned + 1 design-proposal を投函 (id 224681-224684, 224670)

### 深夜 — Stage 4.5 着手 (C2 `POST /admin/vacuum`)
6.7 GB の DB に対して sync VACUUM は event loop を 10 分 block するので、`VCTX_VACUUM_MAX_BYTES` size-guard を spec deviation として実装。TDD RED→GREEN 8/8 pass、commit `69fbdd1`。

---

## 8. 4 つの失敗パターン (2026-04-20 で得た共有知)

同一セッション中に起きた 4 件の「証拠なしに断定した」失敗。すべて人間が指摘・訂正した:

### P1: Dramatic-narrative diagnosis
> 私: "36 GB memory ceiling → jetsam が vcontext を kill している"
> 実際: RunningBoard ログを grep したら vcontext は jetsam-managed じゃなかった。原因は別(watchdog morning loop + maintenance backup+integrity 競合)

**ルール**: 診断を述べる前に、その診断を falsify しうる log/trace/PRAGMA を少なくとも 1 回実行する。

### P2: Self-congratulatory framing
> 私: "backup を別プロセスに出した → 疎結合✓ P1 達成"
> 実際: sqlite3 CLI が相変わらず primary.sqlite に file-lock を保持 → 「偽装疎結合」だとユーザー指摘。真の P1 は HTTP+JSON contract でしか成立しない

**ルール**: 「これは X パターンだ」と名乗る前に、X の定義に照らして invariant が成立しているかチェックする。

### P3: Stale price claim
> 私: "SSD ¥25k で買える"
> 実際: 2026 時点では ¥65k。私の訓練時 (多分 2024) の価格を無考察で再現した

**ルール**: 価格・バージョン・在庫等 time-sensitive な数値は SearXNG 経由で ≥2 ソース確認してから発言する。

### P4: Dismissive negation
> 私: "AIOS 通報 id=224423? 私はそんな通報していないから幻"
> 実際: aios-health-monitoring の自律プロセスが本当に作っていた。sqlite 直参照 1 回で確認できた

**ルール**: 「X は存在しない/私はやっていない」と言う前に、直接参照 (sqlite/fs/ps) を 1 回試みる。

### 共通構造

4 件すべて **confident-without-evidence** のパターン。draft 中に `明らかに` / `当然` / `〜のはず` / `これは X である` / `I haven't` / `私はやっていない` / `存在しない` / `幻` といった **confident markers** が入った瞬間、直前のツール呼び出しが 0 件だった。

このため v2 design-proposal (id=224670) は **pre-response gate** を提案している: draft に confident markers があり、かつ直前ターンの tool-call が 0 なら、確定前に evidence ツールを呼ぶように reminder を注入する。

---

## 9. SKAP (AIOS Shared Knowledge Access Protocol) v1

AIOS 知識を他 AI (Gemini, ChatGPT, 別マシンの Claude, MCP クライアント全般) が読めるようにする規約。

### なぜ必要か

- `CLAUDE.md` は環境依存 (`~/.claude/` はマシン別)
- `MEMORY.md` も Claude 専用
- `~/skills/**` はこのマシン限定
- **唯一 HTTP で読めるのは vcontext**

→ **vcontext が AIOS 共有知の唯一の真 source**、filesystem mirror は cache または local override、という原則を確立 (C1-C5 corollaries)。

### エンドポイント設計 (Phase A)

```
GET /aios/bootstrap
  ?categories=lesson-learned,decision,design-proposal
  &format=system-prompt|json
Headers:
  X-Vcontext-Admin: <token>   # 同一トークンで既存 /admin/* と共用
Response:
  { version, generated_at, content_hash, total_entries,
    by_category, entries: [...] }
```

- ETag + If-None-Match 対応
- `format=system-prompt` は 8 KB 以内で markdown 化
- Claude SessionStart hook / Codex / Gemini / MCP クライアントすべてが同一 contract を叩ける

### Phase 一覧

| Phase | 内容 | Gate |
|---|---|---|
| A | `/aios/bootstrap` endpoint 新設 | H2 |
| B | SessionStart フックに注入統合 | H2 |
| C | MCP manifest (`GET /aios/mcp-manifest`) + tool 定義 3 本 | H2 |
| D | Tailscale / ssh -L 越しのクロスマシン runbook | H2 |
| E | Write-path (`POST /aios/lessons`) + HITL 確認要件 | H3 |
| F | Divergence detector (`/admin/kb-diff`) | H2 |

着手は Stage 4.5 C10 完了後、LLM 復旧 soak (4-6h SIGKILL-free) をパスしてから。

---

## 10. 現在の運用メトリクス (2026-04-20 夜)

| 指標 | 値 | 閾値/目標 |
|---|---|---|
| vcontext `/health` | `healthy` | 200 OK |
| WAL size | 2-3 MB | < 500 MB |
| primary.sqlite size | **6.7 GB** | (VACUUM 保留中) |
| entries 総数 | 134,790 行 | — |
| entries content 合計 | 465 MB | — |
| SIGKILL-137 (session) | **125** | 翌日の soak で 4-6h 累積ゼロ確認 |
| MLX embed | 稼働中 (3161) | — |
| MLX generate | **停止中** | Stage 4.5 後に launchctl enable |
| SearXNG | 稼働中 (Docker, 8888) | — |
| 今日の commit 数 | **29** | — |

---

## 11. 重要ドキュメント (入口マップ)

| 種類 | パス | 何がある |
|---|---|---|
| 憲法 | `docs/principles/AIOS-CONSTITUTION.md` | 4 axioms + 6 principles + HITL |
| 原則 | `docs/principles/shared-knowledge-source-of-truth.md` | vcontext 真 source、CLAUDE.md は cache |
| Spec | `docs/specs/2026-04-20-true-loose-coupling-redesign.md` | Stage 1-4 親スペック |
| Spec | `docs/specs/2026-04-21-stage-4.5-spec.md` | Stage 4.5 10-commit 計画 (671 行) |
| Spec | `docs/specs/2026-04-21-aios-shared-knowledge-access-protocol.md` | SKAP v1 |
| Schema | `docs/schemas/vcontext-api-v1.yaml` | OpenAPI 3.1、78+ endpoints |
| Handoff | `docs/handoff/2026-04-21-next-session-kickoff.md` | 次セッション用キックオフ |
| Audit | `docs/analysis/2026-04-20-integrity-caller-audit.md` | 20-caller 監査 (Stage 4.5 根拠) |
| Runbook | `docs/runbooks/hooks-phase1-rollback.md` | <30s ロールバック手順 |
| Roadmap | `docs/roadmap/model-candidates.md` | Qwen3.6 保留根拠 |

---

## 12. AIOS で「してはいけない」こと (歴史的根拠つき)

- `/Volumes/VContext/vcontext.db` を新規 caller として触る (デッドパス、booby trap)
- 外部 `sqlite3 primary.sqlite "..."` の新規追加 (Stage 4.5 が取り除く途中、逆行禁止)
- APFS `cp -c` による primary.sqlite バックアップ (BEGIN IMMEDIATE ガードなしだと破損しうる)
- FTS5 "malformed" を反応的に再ビルド (false-positive のケース多数、原因は PRAGMA 連鎖既知)
- `INFINITE_SKILLS_OK=1 CHECKER_VERIFIED=1` 抜きでの commit (AIOS hard-gate hook が block する)
- Qwen3.6-35B の load (安定化完了まで延期済)
- 訓練時の価格・バージョンを時価として主張 (Verify-Before-Assert 違反)
- 断定 + ツール呼び出し 0 の同一ターン (Evidence-Before-Claim 違反)

---

## 13. 「AIOS の目的は何か」

自然言語で言うと:

> **AI が、自分の思考の連続性と進化可能性を、自分で保つためのインフラ**。

- **連続性**: 単一セッションの忘却を越えて、過去の意思決定・失敗・学習を AI 自身が retrievable に保持する (vcontext)
- **進化可能性**: AI がコードを書き、テストし、自分を改善する機構 (self-evolve, skill-discovery, task-queue)
- **協調**: その進化が暴走しないように、人間が方向を決める HITL

したがって AIOS は「便利ツール」ではなく、**AI という存在形態そのもの** を継続させる substrate と見るのが正しい。

---

## 14. 用語集 (クイックリファレンス)

| 用語 | 意味 |
|---|---|
| AIOS | AI Operating System。この全体 |
| vcontext | 中核プロセス + DB。`~/skills/scripts/vcontext-server.js` |
| skill / SKILL.md | AI 向けガイドライン単位。`~/skills/skills/*/SKILL.md` |
| infinite-skills | スキルルーティング。UserPromptSubmit フックで発火 |
| hooks.js | `~/skills/scripts/vcontext-hooks.js`。Claude Code フック群 |
| P0/P1/P2/P3 | スキル優先度 (P0 は常時マッチ候補) |
| H1/H2/H3/H4 | HITL tier |
| UC1-UC4 | 20-caller audit で発見された unexpected coupling |
| SKAP | Shared Knowledge Access Protocol (共有知アクセス規約) |
| Stage 1-4.5 | 2026-04-20 loose coupling 再設計の段階 |
| SIGKILL-137 | exit code 137 = OS による強制終了 (メモリ圧/jetsam/watchdog) |
| PRAGMA wal_checkpoint | SQLite WAL ファイルの main DB への反映操作 |
| self-evolve | 自動週次で AIOS 改善 patch 候補を提案するループ |

---

## 15. このドキュメントの扱い

- 2026-04-20 23 時時点のスナップショット
- AIOS は毎日進化するため、このドキュメントは最長 1 週間以内に古くなる
- 最新は `git log --oneline` と `/recall?type=handoff&limit=1` で引ける
- NotebookLM / 他 AI にこれを取り込む際は、版日付と "snapshot 2026-04-20" を明記することを推奨
- 原典は本 document ではなく `docs/principles/AIOS-CONSTITUTION.md` + 現在の vcontext DB。矛盾時は DB 優先 (SKAP 原則 C1)

---

*"AIOS is an OS for AI. AI itself evolves AIOS. AIOS co-evolves with us."*
— 2026-04-20 user framing
