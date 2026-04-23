#!/usr/bin/env node
// article-scanner.js — Daily external-article discovery pipeline
//
// Mission (Pillar 2 external-input feed for the AIOS Cognitive Substrate):
//   1. Sweep Qiita / Zenn / classmethod every day for AIOS-relevant content
//   2. Fetch full article body (not just title/snippet)
//   3. Follow 1-hop internal links for depth
//   4. LLM-evaluate applicability to AIOS (using local MLX generate)
//   5. High-applicability findings → pending-idea entries surfaced on Dashboard
//
// Entry types produced:
//   external-article       — raw HTML-stripped text + metadata
//   article-evaluation     — LLM judgment (score + idea-transfer)
//   pending-idea           — actionable insights awaiting user review
//   article-digest         — daily roll-up (one per run)
//
// Invocation:
//   node scripts/article-scanner.js              # full scan
//   node scripts/article-scanner.js --dry-run    # no writes
//   node scripts/article-scanner.js --max 3      # cap articles per source
//   node scripts/article-scanner.js --verbose    # log per-article

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';

const VCONTEXT = process.env.VCONTEXT_URL || 'http://127.0.0.1:3150';
const SEARXNG = process.env.SEARXNG_URL || 'http://127.0.0.1:8888';
const MLX_GEN = process.env.MLX_GENERATE_URL || 'http://127.0.0.1:3162';
const MLX_MODEL = process.env.MLX_GENERATE_MODEL || 'mlx-community/Qwen3-8B-4bit';

// Sources — add here to expand coverage. `domain` is the site: operator.
// `link_pattern` selects "follow-worthy" internal links (we want the deeper
// technical refs, not nav/profile pages).
// Sources — day-of-week rotation keeps load predictable while expanding breadth.
// `days` is a set of weekday numbers (0=Sun .. 6=Sat) this source runs on.
// `everyday:true` sources run daily regardless.
// `category` is metadata for the digest output.
// `link_pattern` restricts 1-hop link following to in-site technical refs.
const SOURCES = [
  // ── JP tech blogs (daily — core loop, user-provided list) ──
  {
    name: 'qiita', category: 'jp-blog', everyday: true,
    domain: 'qiita.com',
    link_pattern: /^https?:\/\/qiita\.com\/[^/]+\/items\/[a-f0-9]+$/i,
  },
  {
    name: 'zenn', category: 'jp-blog', everyday: true,
    domain: 'zenn.dev',
    link_pattern: /^https?:\/\/zenn\.dev\/[^/]+\/articles\/[a-z0-9-]+$/i,
  },
  {
    name: 'classmethod', category: 'jp-blog', everyday: true,
    domain: 'dev.classmethod.jp',
    link_pattern: /^https?:\/\/dev\.classmethod\.jp\/articles\/[^/]+\/?$/i,
  },
  // ── Papers (weekend-heavy, deeper reads) ──
  {
    name: 'arxiv', category: 'paper', days: [1, 4], // Mon, Thu
    domain: 'arxiv.org',
    // Abstract pages only (PDFs would overwhelm stripHtml)
    link_pattern: /^https?:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}(v\d+)?$/i,
  },
  {
    name: 'huggingface-papers', category: 'paper', days: [2, 5], // Tue, Fri
    domain: 'huggingface.co',
    link_pattern: /^https?:\/\/huggingface\.co\/papers\/\d{4}\.\d{4,5}$/i,
  },
  // ── OSS / GitHub releases ──
  {
    name: 'github', category: 'oss', days: [3, 6], // Wed, Sat
    domain: 'github.com',
    // README or release pages are useful; issues/PRs are too noisy
    link_pattern: /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(releases\/tag|blob\/[^/]+\/README|tree)[^?]*$/i,
  },
  // ── Vendor blogs (weekly or twice-weekly news) ──
  {
    name: 'anthropic', category: 'vendor-blog', days: [0, 3], // Sun, Wed
    domain: 'anthropic.com',
    link_pattern: /^https?:\/\/(www\.)?anthropic\.com\/(news|research|engineering)\/[a-z0-9-]+$/i,
  },
  {
    name: 'openai', category: 'vendor-blog', days: [1, 4], // Mon, Thu
    domain: 'openai.com',
    link_pattern: /^https?:\/\/openai\.com\/index\/[a-z0-9-]+\/?$/i,
  },
  {
    name: 'google-ai', category: 'vendor-blog', days: [2, 5], // Tue, Fri
    domain: 'ai.google.dev',
    link_pattern: /^https?:\/\/ai\.google\.dev\/(gemini-api|edge|responsible-ai)/i,
  },
  // ── News aggregators (high signal, low cost) ──
  {
    name: 'hackernews', category: 'news', days: [0, 2, 4, 6], // 週4回
    domain: 'news.ycombinator.com',
    // HN item pages — scanner will hit these via search, body = comments + title
    link_pattern: /^https?:\/\/news\.ycombinator\.com\/item\?id=\d+$/i,
  },
  {
    name: 'deeplearning-batch', category: 'newsletter', days: [5], // Fri
    domain: 'deeplearning.ai',
    link_pattern: /^https?:\/\/www\.deeplearning\.ai\/the-batch\/[a-z0-9-]+\/?$/i,
  },
];

// Keywords — rotate subset each run to cover breadth over ~week.
// Mixed ja/en; ja keywords tend to land on qiita/zenn/classmethod,
// en keywords on arxiv/hn/vendor blogs. SearXNG handles language auto.
const KEYWORDS = [
  // AIOS core interests (high reuse across sources)
  'MLX Apple Silicon LLM',
  'Claude Code agent skills',
  'MCP protocol Anthropic',
  'AI エージェント 長期記憶',
  'sqlite-vec embedding',
  'Claude Code hooks',
  'self-improving agent',
  'AI OS architecture',
  'long-context retrieval 2026',
  'local LLM inference 最適化',
  'Anthropic agent teams',
  'vibe coding Claude',
  'OpenTelemetry GenAI',
  'LLM memory hierarchy',
  'multi-agent orchestration',
  // Paper-leaning keywords (arxiv, huggingface papers)
  'hierarchical attention long context',
  'KV cache compression',
  'agentic retrieval benchmark',
  'evolutionary code generation LLM',
  'small language model fine-tuning',
  // Observability / infra
  'Langfuse LLM observability',
  'GenAI semantic conventions OpenTelemetry',
  // Tooling / ecosystem
  'Model Context Protocol server',
  'Apple MLX quantization 4bit',
  'Qwen3 local inference',
];

// Tunables — all overridable via env for one-off runs
const MAX_ARTICLES_PER_SOURCE = parseInt(process.env.SCANNER_MAX_PER_SOURCE) || 2;
const MAX_KEYWORDS_PER_RUN    = parseInt(process.env.SCANNER_MAX_KEYWORDS) || 4;
const FORCE_ALL_SOURCES       = process.env.SCANNER_ALL_SOURCES === '1';
const MAX_LINK_HOPS           = parseInt(process.env.SCANNER_MAX_LINKS) || 2;
const FETCH_TIMEOUT_MS        = parseInt(process.env.SCANNER_FETCH_TIMEOUT) || 15000;
const POLITE_SLEEP_MS         = parseInt(process.env.SCANNER_POLITE_SLEEP) || 2000;
const LLM_TIMEOUT_MS          = parseInt(process.env.SCANNER_LLM_TIMEOUT) || 120000;
const APPLICABILITY_THRESHOLD = parseInt(process.env.SCANNER_THRESHOLD) || 7;  // 1-10

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const MAX_OVERRIDE = args.includes('--max') ? parseInt(args[args.indexOf('--max')+1]) : null;

function log(...msgs) { console.log(new Date().toISOString(), '[scanner]', ...msgs); }
function vlog(...msgs) { if (VERBOSE) log(...msgs); }

// ── HTTP helpers ──────────────────────────────────────────────

function httpGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      timeout: opts.timeout || FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; AIOS-article-scanner/1.0) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
        'Accept-Language': 'ja,en;q=0.8',
        ...(opts.headers || {}),
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 1-hop redirect follow
        return httpGet(new URL(res.headers.location, url).toString(), { ...opts, redirected: true })
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode} for ${urlStr}`));
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 2_000_000) { req.destroy(); reject(new Error('response too large')); }
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.end();
  });
}

function httpPostJson(urlStr, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      timeout: opts.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(opts.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML → text ──────────────────────────────────────────────

function stripHtml(html, limit = 12000) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html || '');
  return m ? m[1].trim().slice(0, 200) : '';
}

function extractLinks(html, baseUrl, pattern, max) {
  if (!html) return [];
  const links = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) && links.size < max * 5) {
    try {
      const abs = new URL(m[1], baseUrl).toString().split('#')[0];
      if (pattern.test(abs) && abs !== baseUrl) links.add(abs);
    } catch {}
  }
  return Array.from(links).slice(0, max);
}

// ── SearXNG wrapper ──────────────────────────────────────────

async function searxngSearch(query, domain) {
  const q = `site:${domain} ${query}`;
  try {
    const { body } = await httpGet(`${SEARXNG}/search?q=${encodeURIComponent(q)}&format=json&language=auto`);
    const data = JSON.parse(body);
    const results = (data.results || []).filter(r => r.url && r.url.includes(domain));
    return results.map(r => ({ url: r.url, title: r.title || '', snippet: r.content || '' }));
  } catch (e) {
    log(`searxng query failed (${query} @ ${domain}):`, e.message);
    return [];
  }
}

// ── MLX evaluation ────────────────────────────────────────────

const EVAL_PROMPT_SYSTEM = `You are evaluating a technical article for applicability to AIOS — an Apple-Silicon-local AI memory substrate (Node.js + SQLite + sqlite-vec + MLX Qwen3-8B) that hooks into Claude Code / Codex / Cursor / Kiro and records all tool-calls into a hierarchical memory (L1=10min chunk-summary, L2=daily, L3=weekly planned). AIOS already has: background loops (embed/discovery/predictive/chunk-summary), self-improve pipeline, 217 skills, watchdog, event-loop watchdog.

Your job: given an article, rate AIOS-applicability (1-10), extract 1-2 actionable ideas, and estimate effort (S/M/L).

Respond in STRICT JSON (no markdown, no preamble):
{
  "score": 1-10,
  "summary_ja": "一行",
  "idea_transfer": "一段落 (1-3文)",
  "effort": "S" | "M" | "L",
  "tags": ["tag1","tag2"],
  "confidence": "high" | "medium" | "low"
}`;

async function evaluateArticle(article, linkedTexts) {
  const contextText = [
    `TITLE: ${article.title}`,
    `URL: ${article.url}`,
    `SOURCE: ${article.source}`,
    ``,
    `BODY (${article.text.length} chars):`,
    article.text.slice(0, 8000),
    ...(linkedTexts.length ? [``, `LINKED REFERENCES (${linkedTexts.length}):`, ...linkedTexts.map((t, i) => `--- ref ${i+1} ---\n${t.slice(0, 2000)}`)] : []),
  ].join('\n');

  const reqBody = {
    model: MLX_MODEL,
    messages: [
      { role: 'system', content: EVAL_PROMPT_SYSTEM },
      { role: 'user', content: contextText + '\n\n/no_think' },
    ],
    max_tokens: 800,
    temperature: 0.2,
  };

  try {
    const { status, body } = await httpPostJson(`${MLX_GEN}/v1/chat/completions`, reqBody, { timeout: LLM_TIMEOUT_MS });
    if (status !== 200) throw new Error(`mlx status ${status}: ${body.slice(0, 200)}`);
    const data = JSON.parse(body);
    const content = data.choices?.[0]?.message?.content || '';
    // Extract JSON from response (MLX may wrap in ```json ... ```)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in response: ' + content.slice(0, 200));
    const parsed = JSON.parse(jsonMatch[0]);
    // Coerce shape
    return {
      score: Math.max(1, Math.min(10, parseInt(parsed.score) || 1)),
      summary_ja: String(parsed.summary_ja || '').slice(0, 400),
      idea_transfer: String(parsed.idea_transfer || '').slice(0, 800),
      effort: ['S','M','L'].includes(parsed.effort) ? parsed.effort : 'M',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map(t => String(t).slice(0, 40)) : [],
      confidence: ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    };
  } catch (e) {
    log(`eval failed for ${article.url}:`, e.message.slice(0, 200));
    return null;
  }
}

// ── vcontext integration ──────────────────────────────────────

async function vcontextStore(type, content, tags, session = 'article-scanner') {
  if (DRY_RUN) { vlog(`[DRY] store ${type} ${tags.join(',')}`); return { dryRun: true }; }
  const body = {
    type,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    tags,
    session,
  };
  try {
    const { status, body: resBody } = await httpPostJson(`${VCONTEXT}/store`, body);
    if (status !== 201 && status !== 200) throw new Error(`store ${status}: ${resBody.slice(0, 200)}`);
    return JSON.parse(resBody);
  } catch (e) {
    log(`vcontext store failed (${type}):`, e.message);
    return null;
  }
}

async function alreadyScanned(url) {
  // Check if this URL was already stored as external-article recently (14 days).
  // Uses URL hash tag for fast dedup. Server-side FTS LIKE is O(index),
  // acceptable for daily cron.
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  try {
    const { body } = await httpGet(`${VCONTEXT}/recall?q=article-hash-${hash}&type=external-article&limit=1`);
    const data = JSON.parse(body);
    return (data.results || []).length > 0;
  } catch { return false; }
}

// ── Main scan ────────────────────────────────────────────────

async function scanOne(keyword, source) {
  vlog(`→ ${source.name} : ${keyword}`);
  const results = await searxngSearch(keyword, source.domain);
  if (results.length === 0) { vlog('  no results'); return 0; }

  const cap = MAX_OVERRIDE || MAX_ARTICLES_PER_SOURCE;
  let stored = 0, highImpact = 0;

  for (const r of results.slice(0, cap)) {
    await sleep(POLITE_SLEEP_MS);
    if (await alreadyScanned(r.url)) { vlog(`  skip (dedup): ${r.url}`); continue; }

    let html;
    try { ({ body: html } = await httpGet(r.url)); }
    catch (e) { vlog(`  fetch failed ${r.url}: ${e.message}`); continue; }

    const title = extractTitle(html) || r.title;
    const text = stripHtml(html);
    if (text.length < 400) { vlog(`  too short: ${r.url}`); continue; }

    // 1-hop link following — fetch up to N internal links for depth
    const linkedTexts = [];
    const links = extractLinks(html, r.url, source.link_pattern, MAX_LINK_HOPS);
    for (const l of links) {
      await sleep(POLITE_SLEEP_MS);
      try {
        const { body: lh } = await httpGet(l, { timeout: 10000 });
        const lt = stripHtml(lh, 4000);
        if (lt.length > 200) linkedTexts.push(lt);
      } catch {}
    }

    const article = { url: r.url, title, text, source: source.name, snippet: r.snippet };
    vlog(`  eval (${text.length} chars + ${linkedTexts.length} refs): ${title.slice(0, 60)}`);
    const evalResult = await evaluateArticle(article, linkedTexts);

    const urlHash = createHash('sha256').update(r.url).digest('hex').slice(0, 16);
    const articlePayload = {
      url: r.url, title, source: source.name, keyword,
      text_length: text.length,
      linked_refs: linkedTexts.length,
      fetched_at: new Date().toISOString(),
      text: text.slice(0, 8000),
    };
    await vcontextStore('external-article', articlePayload, ['external-article', `source:${source.name}`, `article-hash-${urlHash}`]);

    if (!evalResult) { vlog('  eval failed — stored raw only'); stored++; continue; }

    const evalPayload = {
      url: r.url, title, source: source.name,
      evaluated_at: new Date().toISOString(),
      ...evalResult,
    };
    await vcontextStore('article-evaluation', evalPayload, ['article-evaluation', `source:${source.name}`, `score:${evalResult.score}`, ...evalResult.tags.map(t => `topic:${t}`)]);

    if (evalResult.score >= APPLICABILITY_THRESHOLD) {
      highImpact++;
      const ideaPayload = {
        url: r.url, title, source: source.name,
        score: evalResult.score,
        summary_ja: evalResult.summary_ja,
        idea_transfer: evalResult.idea_transfer,
        effort: evalResult.effort,
        tags: evalResult.tags,
        confidence: evalResult.confidence,
        status: 'pending-review',
        created_at: new Date().toISOString(),
      };
      await vcontextStore('pending-idea', ideaPayload, ['pending-idea', `source:${source.name}`, `effort:${evalResult.effort}`, ...evalResult.tags.map(t => `topic:${t}`)]);
      log(`  ★ high-impact (${evalResult.score}/10): ${title.slice(0, 80)}`);
    } else {
      vlog(`  score ${evalResult.score}/10 (below ${APPLICABILITY_THRESHOLD} threshold)`);
    }
    stored++;
  }

  return { stored, highImpact };
}

function pickKeywords() {
  // Rotate: use date-derived seed so each day covers different subset.
  const dayIdx = Math.floor(Date.now() / 86400000);
  const keywords = [...KEYWORDS];
  // Fisher-Yates with seeded RNG for reproducible-per-day order
  let seed = dayIdx * 2654435761 >>> 0;
  for (let i = keywords.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [keywords[i], keywords[j]] = [keywords[j], keywords[i]];
  }
  return keywords.slice(0, MAX_KEYWORDS_PER_RUN);
}

function sourcesForToday() {
  // Bypass toggle for one-off "scan everything" runs (env SCANNER_ALL_SOURCES=1
  // or CLI --all).  Useful for post-launch verification or catch-up scans.
  if (FORCE_ALL_SOURCES || process.argv.includes('--all')) return SOURCES.slice();
  const today = new Date().getUTCDay(); // 0 Sun .. 6 Sat (UTC — aligned with LaunchAgent)
  return SOURCES.filter(s => s.everyday || (Array.isArray(s.days) && s.days.includes(today)));
}

async function main() {
  const t0 = Date.now();
  const keywords = pickKeywords();
  const sources = sourcesForToday();
  const totalArticles = sources.length * keywords.length * MAX_ARTICLES_PER_SOURCE;
  log(`starting scan — ${sources.length}/${SOURCES.length} sources × ${keywords.length} keywords × up to ${MAX_ARTICLES_PER_SOURCE} articles = ${totalArticles} max`);
  log(`sources today: ${sources.map(s => s.name).join(', ')}`);
  log(`keywords today: ${keywords.map(k => `"${k}"`).join(', ')}`);
  if (DRY_RUN) log('DRY RUN — no writes');

  // Verify MLX is available before starting. If unavailable, treat as
  // "user opted out of LLM-backed scanning" rather than a failure —
  // exit 0 so Check #8 doesn't flag the daily cron as unhealthy and
  // the macOS launchd-unhealthy notification doesn't fire every
  // morning. Same A-alt pattern as new-feature-watcher (commit
  // 5f6ed4a) and conversation-skill-miner (commit 41f205c). Applied
  // 2026-04-23 after popup spam from this known skip.
  try {
    const { status } = await httpGet(`${MLX_GEN}/v1/models`, { timeout: 5000 });
    if (status !== 200) throw new Error(`mlx status ${status}`);
  } catch (e) {
    log(`[skipped] MLX generate unavailable (${e.message}). Daily scan skipped — no action needed. Enable com.vcontext.mlx-generate to reactivate.`);
    process.exit(0);
  }

  const summary = {
    started_at: new Date(t0).toISOString(),
    sources_scanned: sources.map(s => s.name),
    sources_skipped_today: SOURCES.filter(s => !sources.includes(s)).map(s => s.name),
    keywords_used: keywords,
    per_source: {},
    total_stored: 0,
    total_high_impact: 0,
  };

  for (const source of sources) {
    summary.per_source[source.name] = { stored: 0, high_impact: 0, category: source.category };
    for (const keyword of keywords) {
      try {
        const res = await scanOne(keyword, source);
        if (res && typeof res === 'object') {
          summary.per_source[source.name].stored += res.stored;
          summary.per_source[source.name].high_impact += res.highImpact;
          summary.total_stored += res.stored;
          summary.total_high_impact += res.highImpact;
        }
      } catch (e) { log(`scan error (${source.name} / ${keyword}):`, e.message); }
    }
  }

  summary.duration_ms = Date.now() - t0;
  summary.completed_at = new Date().toISOString();
  log(`completed in ${(summary.duration_ms/1000).toFixed(1)}s — stored=${summary.total_stored} high-impact=${summary.total_high_impact}`);
  log('per-source:', JSON.stringify(summary.per_source));

  // Daily digest entry for dashboard surfacing
  await vcontextStore('article-digest', summary, ['article-digest', `date:${new Date().toISOString().slice(0,10)}`]);

  process.exit(0);
}

main().catch(e => { log('FATAL:', e.stack || e.message); process.exit(1); });
