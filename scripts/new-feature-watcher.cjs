#!/usr/bin/env node
/**
 * new-feature-watcher.cjs
 *
 * 新しいAIツール・製品リリース・概念・パターンを毎日監視し、スキルが存在しない場合に
 * SKILL.md候補を自動生成してvcontextのpending-patchに登録する。
 *
 * 実行: node scripts/new-feature-watcher.cjs
 * LaunchAgent: com.vcontext.new-feature-watcher (毎日 10:00)
 */

'use strict';

const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { extractJson, sanitizeSkillName, assertSkillPathSafe } = require(path.join(__dirname, 'lib', 'llm-parse.cjs'));

const VCONTEXT = 'http://127.0.0.1:3150';
const SEARXNG  = 'http://127.0.0.1:8888';
const SKILLS_ROOT = path.join(process.env.HOME, 'skills', 'skills');
const DRY_RUN = process.argv.includes('--dry-run');

// 監視対象ソース（優先度順）
const WATCH_SOURCES = [
  // Anthropic
  'site:anthropic.com/news new tool product feature 2026',
  'site:anthropic.com/research announcement 2026',
  // OpenAI / Google / 競合
  'site:openai.com/blog new feature 2026',
  'site:deepmind.google new AI tool 2026',
  // AI製品ニュース
  '"new AI tool" OR "new AI feature" OR "launches AI" site:techcrunch.com',
  '"new AI product" site:venturebeat.com',
  'site:news.ycombinator.com "Show HN" AI tool 2026',
  // 日本語
  'site:ai.watch.impress.co.jp 新機能 新サービス 2026',
  'site:zenn.dev 新ツール OR 新機能 AIエージェント 2026',
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

// ── SearXNG 検索 ─────────────────────────────────

function searxSearch(query, afterDate) {
  const q = afterDate ? `${query} after:${afterDate}` : query;
  const url = `${SEARXNG}/search?q=${encodeURIComponent(q)}&format=json&time_range=day`;
  return new Promise((res) => {
    http.get(url, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const data = JSON.parse(d);
          res((data.results || []).slice(0, 5).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.content?.slice(0, 300) || ''
          })));
        } catch { res([]); }
      });
    }).on('error', () => res([]));
  });
}

// ── LLM 呼び出し ─────────────────────────────────

async function callLLM(prompt) {
  // MLX ローカル試行
  try {
    const body = JSON.stringify({
      model: 'mlx-community/Qwen3-8B-4bit',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048, temperature: 0.3
    });
    const result = await new Promise((res, rej) => {
      const opts = {
        host: '127.0.0.1', port: 3162, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 90000
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
    if (text) { console.log('[watcher] LLM: MLX'); return text; }
  } catch (e) {
    console.warn('[watcher] MLX unavailable:', e.message);
  }

  // Claude Haiku フォールバック
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5', max_tokens: 2048,
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

// ── 既存スキルチェック ────────────────────────────

function getExistingSkills() {
  try {
    return fs.readdirSync(SKILLS_ROOT).filter(d =>
      fs.existsSync(path.join(SKILLS_ROOT, d, 'SKILL.md'))
    );
  } catch { return []; }
}

// ── 新ツール検出 ─────────────────────────────────

async function detectNewTools(results, existingSkills, lastRun) {
  if (results.length === 0) return [];

  const prompt = `あなたはAIエージェントのスキルライブラリ管理者です。
以下の最新AI/開発ツールニュースを分析して、スキル化すべき新しいツール・製品・機能を特定してください。

## 検索結果（${new Date().toISOString().slice(0,10)}）
${results.slice(0, 15).map((r, i) => `${i+1}. [${r.title}](${r.url})\n   ${r.snippet}`).join('\n\n')}

## 既存スキル一覧（重複回避）
${existingSkills.slice(0, 50).join(', ')}

## 指示
1. 上記ニュースから「スキル化する価値がある新ツール・機能」を最大5件抽出
2. 既存スキルと重複するものは除外
3. 確実に「新製品/新機能リリース」と判断できるものだけ選ぶ（噂・予測は除外）

出力形式（JSONのみ）:
{
  "tools": [
    {
      "name": "スキル名（英小文字・ハイフン区切り）",
      "display_name": "製品正式名",
      "description": "1-2文の説明（Use when...形式）",
      "source_url": "ソースURL",
      "confidence": 0.0-1.0,
      "why_skill": "なぜスキル化すべきか1行"
    }
  ],
  "skipped": ["スキップした理由のサマリー"]
}`;

  const raw = await callLLM(prompt);
  const parsed = extractJson(raw);
  if (!parsed) return [];
  const tools = (parsed.tools || []).filter(t => t && t.confidence >= 0.7);
  // Sanitize every name before it can flow into target_path / tags.
  const safe = [];
  for (const t of tools) {
    const clean = sanitizeSkillName(t.name);
    if (!clean) {
      console.warn(`[watcher] rejected unsafe skill name: ${JSON.stringify(t.name)}`);
      continue;
    }
    safe.push({ ...t, name: clean });
  }
  return safe;
}

// ── SKILL.md 生成 ────────────────────────────────

async function generateSkillMd(tool) {
  const prompt = `以下のAIツール・製品のSKILL.mdを作成してください。

ツール名: ${tool.display_name}
スキル名: ${tool.name}
説明: ${tool.description}
ソース: ${tool.source_url}
なぜスキル化: ${tool.why_skill}

要件:
- ~/skills/skills/ のSKILL.mdフォーマットに従う
- frontmatter: name: ${tool.name}, description: |（Use when含む日本語+英語）, origin: auto-discovered
- ## Workflow: 具体的な使い方ステップ（3-6ステップ）
- ## Gotchas: 既知の落とし穴・注意点
- ## アクセス: URL・料金・APIの有無
- 実際に動くコード例やコマンドを含める
- 200-400行以内

フォーマット厳守。YAMLフロントマターから始めること。`;

  const raw = await callLLM(prompt);
  // frontmatterで始まるテキストを抽出
  const match = raw.match(/^---[\s\S]*?---[\s\S]*/m);
  return match ? match[0] : raw;
}

// ── メイン ───────────────────────────────────────

async function main() {
  console.log('[watcher] === new-feature-watcher start ===');

  // vcontext 疎通確認
  try {
    const health = await vcGet('/health');
    if (health.status !== 'healthy') { console.log('[watcher] vcontext unhealthy, skip'); return; }
  } catch { console.log('[watcher] vcontext unreachable, skip'); return; }

  // 前回実行日時を取得
  const cpData = await vcGet('/recall?type=watcher-checkpoint&limit=1');
  const lastCheckpoint = cpData.results?.[0];
  let lastRun = '2026-01-01';
  try {
    const c = JSON.parse(lastCheckpoint?.content || '{}');
    lastRun = c.last_run || lastRun;
  } catch {}
  console.log(`[watcher] last run: ${lastRun}`);

  // 既存スキル一覧
  const existingSkills = getExistingSkills();
  console.log(`[watcher] existing skills: ${existingSkills.length}`);

  // 各ソースを検索
  console.log('[watcher] searching for new tools...');
  const allResults = [];
  for (const query of WATCH_SOURCES) {
    const results = await searxSearch(query, lastRun);
    allResults.push(...results);
    process.stdout.write('.');
  }
  console.log(`\n[watcher] raw results: ${allResults.length}`);

  // 重複URLを排除
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url); return true;
  });
  console.log(`[watcher] unique results: ${unique.length}`);

  if (unique.length === 0) {
    console.log('[watcher] no new results found');
    await saveCheckpoint();
    return;
  }

  // 新ツールを検出
  console.log('[watcher] analyzing for new skill candidates...');
  const newTools = await detectNewTools(unique, existingSkills, lastRun);
  console.log(`[watcher] skill candidates: ${newTools.length}`);

  if (newTools.length === 0) {
    console.log('[watcher] no new skills needed');
    await saveCheckpoint();
    return;
  }

  // 各ツールのSKILL.mdを生成してpending-patchに登録
  const cycleId = new Date().toISOString().slice(0,10);
  let registered = 0;

  for (const tool of newTools) {
    console.log(`\n[watcher] generating skill: ${tool.name} (${tool.display_name})`);
    console.log(`  confidence=${tool.confidence} source=${tool.source_url}`);

    try {
      // Defense-in-depth: even though sanitizeSkillName accepts only
      // [a-z0-9-], assert the resolved path stays inside SKILLS_ROOT before
      // letting this entry into the pending-patch queue.
      try { assertSkillPathSafe(SKILLS_ROOT, tool.name); }
      catch (e) {
        console.error(`[watcher] path escape guard triggered: ${e.message}`);
        continue;
      }

      const skillMd = await generateSkillMd(tool);

      if (DRY_RUN) {
        console.log(`[watcher] DRY-RUN: would register ${tool.name}`);
        console.log(skillMd.slice(0, 200));
        continue;
      }

      await vcPost({
        type: 'pending-patch',
        content: JSON.stringify({
          target_path: `skills/${tool.name}/SKILL.md`,
          proposed_content: skillMd,
          fitness: tool.confidence * 0.75, // 自動生成は最大0.75 — 人間レビュー必須
          source: 'new-feature-watcher',
          source_url: tool.source_url,
          display_name: tool.display_name,
          why_skill: tool.why_skill,
          cycle_id: cycleId,
          reasoning: `New tool detected: ${tool.display_name}. ${tool.why_skill}`,
          auto_approve: false, // 必ずダッシュボードでレビューを要求
          generated_at: new Date().toISOString()
        }),
        tags: ['pending-patch', `source:new-feature-watcher`, `target:${tool.name}`,
               `cycle:${cycleId}`, 'auto-generated', 'requires-review'],
        session: 'skill-discovery'
      });

      // vcontext に skill-suggestion も保存（self-evolveが拾う）
      await vcPost({
        type: 'skill-suggestion',
        content: JSON.stringify({
          suggested_skill: tool.name,
          reason: `New product/feature detected: ${tool.display_name}. ${tool.why_skill}`,
          source_url: tool.source_url,
          confidence: tool.confidence,
          source: 'new-feature-watcher',
          created_at: new Date().toISOString()
        }),
        tags: ['skill-suggestion', `skill:${tool.name}`, 'new-feature-watcher'],
        session: 'skill-discovery'
      });

      console.log(`[watcher] ✓ registered: ${tool.name}`);
      registered++;
    } catch (e) {
      console.error(`[watcher] failed ${tool.name}:`, e.message);
    }
  }

  await saveCheckpoint(registered, newTools.length);
  console.log(`\n[watcher] done: ${registered}/${newTools.length} skills registered as pending-patch`);
  console.log('[watcher] → review at dashboard: http://127.0.0.1:3150/dashboard');
}

async function saveCheckpoint(registered = 0, candidates = 0) {
  await vcPost({
    type: 'watcher-checkpoint',
    content: JSON.stringify({
      last_run: new Date().toISOString(),
      registered,
      candidates,
      source: 'new-feature-watcher'
    }),
    tags: ['watcher-checkpoint', 'new-feature-watcher'],
    session: 'system'
  });
}

main().catch(err => {
  // Graceful skip: both LLMs unavailable is expected when mlx-generate is
  // launchctl-disabled and no ANTHROPIC_API_KEY is configured. Exit 0 so
  // launchd's Check #8 doesn't flag this as a failure — the user has opted
  // out of daily feature watching rather than encountered a bug.
  if (/ANTHROPIC_API_KEY not set/.test(err.message)) {
    console.log('[watcher] Skipped — MLX generate disabled and no ANTHROPIC_API_KEY configured. Enable mlx-generate or set the API key to reactivate.');
    process.exit(0);
  }
  console.error('[watcher] FATAL:', err.message);
  process.exit(1);
});
