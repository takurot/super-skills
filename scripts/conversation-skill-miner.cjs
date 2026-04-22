#!/usr/bin/env node
/**
 * conversation-skill-miner.cjs
 *
 * vcontextに蓄積された過去の会話履歴を分析し、
 * 「こういうスキルがあれば便利だった」という機会を検出して
 * スキル候補をpending-patchに登録する。
 *
 * new-feature-watcherが「外部の新製品」を追跡するのに対し、
 * これは「ユーザー自身のニーズ」から逆算する内向きのマイナー。
 *
 * 実行: node scripts/conversation-skill-miner.cjs
 * LaunchAgent: com.vcontext.conversation-skill-miner (毎日 11:00)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractJson, sanitizeSkillName, assertSkillPathSafe } = require(path.join(__dirname, 'lib', 'llm-parse.cjs'));

const VCONTEXT = 'http://127.0.0.1:3150';
const SKILLS_ROOT = path.join(process.env.HOME, 'skills', 'skills');
const DRY_RUN = process.argv.includes('--dry-run');

// 会話ソースタイプ（vcontextの実際のtype値）
const CONVERSATION_TYPES = [
  'assistant-response',    // Claudeの回答（ユーザー意図の反映）
  'decision',              // 決定事項（繰り返しパターンの源）
  'session-summary',       // セッション要約
  'working-state',         // 現在の作業文脈
  'anomaly-response',      // 異常時対応（スキルギャップの強シグナル）
  'anomaly-alert',         // 異常検知
  'skill-gap',             // 検出済みギャップ
  'skill-suggestion',      // 既存のスキル提案
  'pain-point',            // 困りごと
  'unresolved-question',   // 未解決質問
  'handoff',               // セッション間引き継ぎ
  'chunk-summary',         // 記事要約
  'pending-idea'           // アイデア蓄積
];

// ── vcontext ヘルパー ─────────────────────────────

function vcGet(p) {
  return new Promise((res, rej) => {
    http.get(`${VCONTEXT}${p}`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({ results: [] }); } });
    }).on('error', rej);
  });
}

function vcPost(payload) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(payload);
    const opts = {
      host: '127.0.0.1', port: 3150, path: '/store', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } });
    });
    req.on('error', rej); req.end(body);
  });
}

// ── LLM 呼び出し ─────────────────────────────────

async function callLLM(prompt) {
  // MLX ローカル
  try {
    const body = JSON.stringify({
      model: 'mlx-community/Qwen3-8B-4bit',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3072, temperature: 0.3
    });
    const result = await new Promise((res, rej) => {
      const opts = {
        host: '127.0.0.1', port: 3162, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 120000
      };
      const req = http.request(opts, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch { rej(new Error('parse')); } });
      });
      req.on('error', rej);
      req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
      req.end(body);
    });
    const text = result?.choices?.[0]?.message?.content;
    if (text) { console.log('[miner] LLM: MLX'); return text; }
  } catch (e) {
    console.warn('[miner] MLX unavailable:', e.message);
  }

  // Claude Haiku
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5', max_tokens: 3072,
    messages: [{ role: 'user', content: prompt }]
  });
  return new Promise((res, rej) => {
    const opts = {
      host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01'
      }
    };
    const req = require('https').request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { res(JSON.parse(d).content?.[0]?.text || ''); }
        catch { rej(new Error('Claude parse error')); }
      });
    });
    req.on('error', rej); req.end(body);
  });
}

// ── 既存スキル一覧 ────────────────────────────────

function getExistingSkills() {
  try {
    return fs.readdirSync(SKILLS_ROOT).filter(d =>
      fs.existsSync(path.join(SKILLS_ROOT, d, 'SKILL.md'))
    );
  } catch { return []; }
}

// ── 会話履歴を収集 ────────────────────────────────

async function collectConversations(sinceDate) {
  const all = [];
  const seen = new Set();
  // /recall は q= 必須 — 広範囲クエリで日英両対応、並列実行
  const broadQueries = ['a', 'の'];
  const tasks = [];
  for (const type of CONVERSATION_TYPES) {
    for (const q of broadQueries) {
      tasks.push(vcGet(`/recall?q=${encodeURIComponent(q)}&type=${type}&limit=100`)
        .then(data => ({ type, results: data.results || [] }))
        .catch(() => ({ type, results: [] })));
    }
  }
  const all_data = await Promise.all(tasks);
  for (const { type, results } of all_data) {
    for (const r of results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      try {
        const ts = r.created_at || r.timestamp;
        if (ts && new Date(ts) > new Date(sinceDate)) {
          all.push({
            type,
            content: r.content?.slice(0, 500) || '',
            ts
          });
        }
      } catch {}
    }
  }
  return all;
}

// ── スキル候補を推論 ─────────────────────────────

async function inferSkillCandidates(conversations, existingSkills) {
  if (conversations.length === 0) return [];

  // 会話をカテゴリ別に整理
  const byType = {};
  for (const c of conversations) {
    byType[c.type] = byType[c.type] || [];
    byType[c.type].push(c.content);
  }

  const summary = Object.entries(byType)
    .map(([type, items]) => `### ${type} (${items.length}件)\n${items.slice(0, 8).map((t, i) => `${i+1}. ${t.slice(0, 200)}`).join('\n')}`)
    .join('\n\n');

  const prompt = `あなたはAIエージェントのスキルライブラリ管理者です。
ユーザーの過去の会話履歴を分析し、「こういうスキルがあれば便利だった」という機会を発見してください。
たとえ現時点で使い道が不明瞭でも、繰り返し登場するパターン・作業・ドメイン知識があれば
スキル化の候補として抽出してください。

## 会話履歴のサマリー
${summary}

## 既存スキル一覧（重複回避）
${existingSkills.slice(0, 80).join(', ')}

## 推論の指示
1. ユーザーが繰り返し言及している作業・ツール・概念を抽出
2. 既存スキルと完全に重複するものは除外（部分的に関連する程度ならOK）
3. 「AIの話題（Claude以外も含む）」「開発パターン」「ドメイン知識」「日常ワークフロー」など、
   カテゴリを問わず広く抽出すること
4. 使用頻度が高いほど優先度が上がる
5. まだ使えるか不明でもOK — ユーザーは「作成しないと使えない」と言っている

出力形式（JSONのみ）:
{
  "candidates": [
    {
      "name": "skill-name-kebab-case",
      "display_name": "わかりやすい表示名",
      "category": "ai|dev|domain|workflow|concept",
      "description": "1-2文の説明（Use when...形式）",
      "trigger_keywords": ["トリガーとなるキーワード", "..."],
      "frequency_in_logs": 数値,
      "confidence": 0.0-1.0,
      "why_useful": "なぜこのスキルが必要か1-2文",
      "evidence": ["具体的な会話抜粋1", "会話抜粋2"]
    }
  ],
  "patterns_noticed": "会話全体の傾向を2-3文で"
}`;

  const raw = await callLLM(prompt);
  const parsed = extractJson(raw);
  if (!parsed) return [];
  // confidence >= 0.5 && frequency >= 2 を採用
  const filtered = (parsed.candidates || []).filter(c =>
    c && (c.confidence || 0) >= 0.5 && (c.frequency_in_logs || 0) >= 2
  );
  // Sanitize every name before it can flow into target_path / tags.
  const safe = [];
  for (const c of filtered) {
    const clean = sanitizeSkillName(c.name);
    if (!clean) {
      console.warn(`[miner] rejected unsafe skill name: ${JSON.stringify(c.name)}`);
      continue;
    }
    safe.push({ ...c, name: clean });
  }
  return safe;
}

// ── SKILL.md 生成 ────────────────────────────────

async function generateSkillMd(candidate) {
  const prompt = `以下のスキル候補のSKILL.mdを作成してください。

スキル名: ${candidate.name}
表示名: ${candidate.display_name}
カテゴリ: ${candidate.category}
説明: ${candidate.description}
トリガー: ${candidate.trigger_keywords?.join(', ')}
なぜ必要: ${candidate.why_useful}
証拠となる会話: ${(candidate.evidence || []).join(' / ')}

要件:
- ~/skills/skills/ のSKILL.mdフォーマットに従う
- frontmatter: name, description: |（Use when含む）, origin: conversation-mined
- ## Workflow: 3-6ステップの具体的手順
- ## Gotchas: 既知の落とし穴
- 実用的な内容（ユーザーが実際に使えるコード/手順を含める）
- 150-400行

必ずYAMLフロントマターから始めること。説明文は不要、SKILL.mdの内容だけ出力。`;

  const raw = await callLLM(prompt);
  const match = raw.match(/^---[\s\S]*?---[\s\S]*/m);
  return match ? match[0] : raw;
}

// ── メイン ───────────────────────────────────────

async function main() {
  console.log('[miner] === conversation-skill-miner start ===');

  // vcontext 疎通
  try {
    const h = await vcGet('/health');
    if (h.status !== 'healthy') { console.log('[miner] vcontext unhealthy'); return; }
  } catch { console.log('[miner] vcontext unreachable'); return; }

  // 前回実行
  const cp = await vcGet('/recall?type=miner-checkpoint&tag=conversation-skill-miner&limit=1');
  let lastRun = '2026-04-01';
  try {
    const c = JSON.parse(cp.results?.[0]?.content || '{}');
    lastRun = c.last_run || lastRun;
  } catch {}
  console.log(`[miner] since: ${lastRun}`);

  // 既存スキル
  const existing = getExistingSkills();
  console.log(`[miner] existing skills: ${existing.length}`);

  // 会話収集
  console.log('[miner] collecting conversations...');
  const convs = await collectConversations(lastRun);
  console.log(`[miner] conversations since last run: ${convs.length}`);

  if (convs.length < 5) {
    console.log('[miner] insufficient data, skipping');
    await saveCheckpoint(0, 0);
    return;
  }

  // 推論
  console.log('[miner] inferring skill candidates...');
  const candidates = await inferSkillCandidates(convs, existing);
  console.log(`[miner] candidates: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('[miner] no new candidates');
    await saveCheckpoint(0, 0);
    return;
  }

  // SKILL.md 生成 & pending-patch 登録
  const cycleId = new Date().toISOString().slice(0,10);
  let registered = 0;

  for (const cand of candidates) {
    console.log(`\n[miner] ${cand.name} (${cand.category}) conf=${cand.confidence} freq=${cand.frequency_in_logs}`);

    try {
      // Defense-in-depth: even though sanitizeSkillName accepts only
      // [a-z0-9-], assert the resolved path stays inside SKILLS_ROOT before
      // letting this entry into the pending-patch queue.
      try { assertSkillPathSafe(SKILLS_ROOT, cand.name); }
      catch (e) {
        console.error(`[miner] path escape guard triggered: ${e.message}`);
        continue;
      }

      const skillMd = await generateSkillMd(cand);

      if (DRY_RUN) {
        console.log(`[miner] DRY-RUN skip save: ${cand.name}`);
        console.log(skillMd.slice(0, 200));
        continue;
      }

      // pending-patch
      await vcPost({
        type: 'pending-patch',
        content: JSON.stringify({
          target_path: `skills/${cand.name}/SKILL.md`,
          proposed_content: skillMd,
          fitness: Math.min(0.70, cand.confidence * 0.8), // 会話由来は最大0.70
          source: 'conversation-skill-miner',
          display_name: cand.display_name,
          category: cand.category,
          trigger_keywords: cand.trigger_keywords,
          why_useful: cand.why_useful,
          evidence: cand.evidence,
          cycle_id: cycleId,
          reasoning: `Inferred from ${cand.frequency_in_logs}x user mentions. ${cand.why_useful}`,
          auto_approve: false,
          generated_at: new Date().toISOString()
        }),
        tags: ['pending-patch', 'source:conversation-skill-miner',
               `target:${cand.name}`, `cat:${cand.category}`,
               `cycle:${cycleId}`, 'requires-review'],
        session: 'skill-discovery'
      });

      // skill-suggestion
      await vcPost({
        type: 'skill-suggestion',
        content: JSON.stringify({
          suggested_skill: cand.name,
          reason: `User conversation pattern: ${cand.why_useful}`,
          confidence: cand.confidence,
          source: 'conversation-skill-miner',
          created_at: new Date().toISOString()
        }),
        tags: ['skill-suggestion', `skill:${cand.name}`, 'conversation-mined'],
        session: 'skill-discovery'
      });

      console.log(`[miner] ✓ registered: ${cand.name}`);
      registered++;
    } catch (e) {
      console.error(`[miner] failed ${cand.name}:`, e.message);
    }
  }

  await saveCheckpoint(registered, candidates.length);
  console.log(`\n[miner] done: ${registered}/${candidates.length} registered as pending-patch`);
  console.log('[miner] → dashboard: http://127.0.0.1:3150/dashboard');
}

async function saveCheckpoint(registered, candidates) {
  await vcPost({
    type: 'miner-checkpoint',
    content: JSON.stringify({
      last_run: new Date().toISOString(),
      registered,
      candidates,
      source: 'conversation-skill-miner'
    }),
    tags: ['miner-checkpoint', 'conversation-skill-miner'],
    session: 'system'
  });
}

main().catch(err => {
  // Graceful skip: both LLMs unavailable is expected when mlx-generate is
  // launchctl-disabled and no ANTHROPIC_API_KEY is configured. Exit 0 so
  // launchd's Check #8 doesn't flag this as a failure — the user has opted
  // out of daily skill mining rather than encountered a bug.
  // (Same A-alt template as new-feature-watcher.cjs — commit 5f6ed4a.)
  if (/ANTHROPIC_API_KEY not set/.test(err.message)) {
    console.log('[miner] Skipped — MLX generate disabled and no ANTHROPIC_API_KEY configured. Enable mlx-generate or set the API key to reactivate.');
    process.exit(0);
  }
  console.error('[miner] FATAL:', err.message);
  process.exit(1);
});
