/* =============================================================================
   MYCAST — Backend v2.0
   =============================================================================
   "Set your own daily brief."

   ARCHITECTURE (the whole point):
     - A CATALOG of standing topics is generated ONCE per night, shared by all.
     - A user's brief is ASSEMBLED from pre-made segments (cost to serve ~= $0).
     - Cost scales with TOPICS, not USERS.
     - Custom topics normalize into the shared catalog (the flywheel).

   WHAT THIS FIXES from v9.32:
     - "No news" bug: retrieval NEVER returns empty when news exists (see §5).
     - TTS: OpenAI (~$0.014/audio-min) instead of ElevenLabs (~$0.18). ~13x.
     - Per-user on-demand generation -> nightly batch + assembly.
   ========================================================================== */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RSSParser = require('rss-parser');

const app = express();
app.use(express.json({ limit: '1mb' }));
const rss = new RSSParser({ timeout: 10000 });

const VERSION = 'v2.0';
const PORT = process.env.PORT || 8080;

/* ---------------------------------------------------------------- config -- */
const AK   = process.env.ANTHROPIC_API_KEY || '';
const OAK  = process.env.OPENAI_API_KEY || '';
const MOCK_MODE = !AK || !OAK;

const AUDIO_DIR = process.env.AUDIO_DIR || '/data/audio';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const TTS_PROVIDER = process.env.TTS_PROVIDER || 'openai';
// OpenAI voices. onyx = deep male (news/narration), echo = neutral male,
// alloy = androgynous, fable = British male, nova/coral/shimmer = female.
const VOICES = {
  onyx: 'onyx', echo: 'echo', alloy: 'alloy', fable: 'fable',
  nova: 'nova', coral: 'coral', shimmer: 'shimmer',
};
const DEFAULT_VOICE = 'alloy';   // neutral American; Fable has a British lilt
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';

const MIN_STORIES  = Number(process.env.MIN_STORIES  || 8);
const MAX_SOURCES  = Number(process.env.MAX_SOURCES  || 30);

const FREE_MAX_LEN        = Number(process.env.FREE_MAX_LEN        || 5);
const PAID_MAX_LEN        = Number(process.env.PAID_MAX_LEN        || 20);
const FREE_MAX_CATEGORIES = Number(process.env.FREE_MAX_CATEGORIES || 5);
const PAID_MAX_CUSTOM     = Number(process.env.PAID_MAX_CUSTOM     || 3);
const CATALOG_RETAIN_CYCLES = Number(process.env.CATALOG_RETAIN_CYCLES || 3);

const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || '';
const DEVELOPER_IDS = (process.env.DEVELOPER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const RC_SECRET     = process.env.REVENUECAT_SECRET_KEY || '';
const RC_WEBHOOK    = process.env.REVENUECAT_WEBHOOK_TOKEN || '';

const SEED = require('./catalog_seed.js');

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
function absolute(u) { return PUBLIC_BASE_URL && u.startsWith('/') ? PUBLIC_BASE_URL + u : u; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

/* ------------------------------------------------------------------- db -- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS topics (
      id text PRIMARY KEY,
      kind text NOT NULL,
      label text NOT NULL,
      norm_key text NOT NULL UNIQUE,
      queries jsonb NOT NULL DEFAULT '[]',
      rss_feeds jsonb NOT NULL DEFAULT '[]',
      window_hours int NOT NULL DEFAULT 24,
      hints jsonb NOT NULL DEFAULT '{}',
      subscriber_count int NOT NULL DEFAULT 0,
      is_live boolean NOT NULL DEFAULT true,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS segments (
      id bigserial PRIMARY KEY,
      topic_id text NOT NULL,
      cycle_date date NOT NULL,
      voice text NOT NULL,
      audio_path text NOT NULL,
      duration_sec int NOT NULL DEFAULT 0,
      script text NOT NULL DEFAULT '',
      sources jsonb NOT NULL DEFAULT '[]',
      story_count int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'ok',
      created_at timestamptz DEFAULT now(),
      UNIQUE (topic_id, cycle_date, voice)
    );
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      token text,
      tier text NOT NULL DEFAULT 'free',
      email text,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token text;
    CREATE INDEX IF NOT EXISTS idx_users_token ON users (token);
    CREATE TABLE IF NOT EXISTS user_briefs (
      user_id text PRIMARY KEY,
      topic_ids jsonb NOT NULL DEFAULT '[]',
      length_min int NOT NULL DEFAULT 5,
      voice text NOT NULL DEFAULT 'alloy',
      deliver_at text,
      timezone text DEFAULT 'America/New_York',
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS topic_subscriptions (
      user_id text NOT NULL,
      topic_id text NOT NULL,
      PRIMARY KEY (user_id, topic_id)
    );
    -- daily_briefs table removed: GET always live-assembles now. Drop any
    -- legacy rows so a stale cached manifest can't be served.
    DROP TABLE IF EXISTS daily_briefs;
    CREATE INDEX IF NOT EXISTS idx_seg_topic_date ON segments (topic_id, cycle_date DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_live ON topics (is_live);
  `);
  // Backfill tokens for any pre-token users, in JS so we don't depend on the
  // pgcrypto extension being enabled (gen_random_bytes would crash boot).
  const { rows: legacy } = await pool.query('SELECT id FROM users WHERE token IS NULL');
  for (const u of legacy) {
    await pool.query('UPDATE users SET token=$2 WHERE id=$1',
      [u.id, crypto.randomBytes(24).toString('hex')]);
  }
  if (legacy.length) console.log('backfilled tokens for ' + legacy.length + ' legacy user(s)');

  await seedCategories();
  console.log('db ready');
}

// Curated categories are always live. Idempotent — safe to re-run on deploy.
async function seedCategories() {
  for (const [id, c] of Object.entries(SEED.CATEGORIES)) {
    const hints = {};
    if (c.finance) hints.finance = true;
    if (c.sports)  hints.sports  = true;
    await pool.query(
      `INSERT INTO topics (id, kind, label, norm_key, queries, rss_feeds, window_hours, hints, is_live)
       VALUES ($1,'category',$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (id) DO UPDATE SET
         label=$2, queries=$4, rss_feeds=$5, window_hours=$6, hints=$7, is_live=true`,
      [id, c.label, id, JSON.stringify(c.queries || []), JSON.stringify(c.rss || []),
       c.window_hours || 24, JSON.stringify(hints)]
    );
  }
  console.log('seeded ' + Object.keys(SEED.CATEGORIES).length + ' categories');
}

/* ----------------------------------------------------------------- auth -- */
// Auth = the SECRET token minted at /api/auth/register. The usr_ id is public
// (it's the RevenueCat app_user_id); the token is what proves you own the account.
// Never authenticate on the id alone — it would be trivially guessable.
async function getReqUser(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE token=$1', [bearer]);
  if (!rows[0]) return null;
  const u = rows[0];
  if (DEVELOPER_IDS.includes(u.id)) u.tier = 'paid'; // dev bypass
  return u;
}
function requireUser(fn) {
  return async (req, res) => {
    const u = await getReqUser(req);
    if (!u) return res.status(401).json({ error: 'auth_required' });
    req.user = u;
    return fn(req, res);
  };
}
function requireAdmin(fn) {
  return (req, res) => {
    const t = (req.headers['x-admin-token'] || '').trim();
    if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
    return fn(req, res);
  };
}
const isPaid = u => u.tier === 'paid' || u.tier === 'pro' || u.tier === 'plus';
const maxLenFor = u => (isPaid(u) ? PAID_MAX_LEN : FREE_MAX_LEN);

/* ------------------------------------------------------------ utilities -- */
async function fetchWithRetry(url, opts = {}, cfg = {}) {
  const tries = cfg.tries || 2, timeoutMs = cfg.timeoutMs || 12000;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { lastErr = e; if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}
function makeLimiter(max) {
  let active = 0; const q = [];
  const next = () => { if (active >= max || !q.length) return; active++; const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); }); };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const ttsLimit = makeLimiter(2);
const genLimit = makeLimiter(3); // topics generated in parallel

function hostnameOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function publisherFromFeedUrl(url) {
  const h = hostnameOf(url).toLowerCase();
  if (h.includes('bbc')) return 'BBC News';
  if (h.includes('nytimes')) return 'The New York Times';
  if (h.includes('npr')) return 'NPR';
  if (h.includes('theguardian')) return 'The Guardian';
  if (h.includes('aljazeera')) return 'Al Jazeera';
  if (h.includes('espn')) return 'ESPN';
  if (h.includes('thehill')) return 'The Hill';
  if (h.includes('politico')) return 'Politico';
  if (h.includes('arstechnica')) return 'Ars Technica';
  if (h.includes('theverge')) return 'The Verge';
  if (h.includes('techcrunch')) return 'TechCrunch';
  if (h.includes('marketwatch')) return 'MarketWatch';
  if (h.includes('coindesk')) return 'CoinDesk';
  if (h.includes('sciencedaily')) return 'ScienceDaily';
  return hostnameOf(url) || 'News';
}
// Wire services and majors lead; everything else ranks below.
function sourceQualityScore(s) {
  const hay = ((s.publisher || '') + ' ' + (s.url || '')).toLowerCase();
  if (/reuters|associated press|\bap\b|apnews/.test(hay)) return 3;
  if (/bbc|npr|new york times|nytimes|guardian|al jazeera/.test(hay)) return 2.5;
  if (/bloomberg|wall street journal|wsj|financial times|espn|politico|the hill|ars technica|verge|techcrunch/.test(hay)) return 2;
  return 1;
}
function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function dedupeSources(items) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    if (!it || !it.title) continue;
    const k = normTitle(it.title).slice(0, 80);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}
function currentDateContext() {
  const d = new Date();
  return 'Today is ' + d.toLocaleDateString('en-US',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' }) + '.';
}

/* =============================================================================
   §5  RETRIEVAL — "never return empty when news exists"
   -----------------------------------------------------------------------------
   THE BUG WE'RE FIXING: v9.32 did `if (ts < cutoff) continue;` which silently
   DELETED stories whose RSS timestamp fell outside the window. RSS timestamps
   are unreliable (often index-time, not publish-time), so real stories vanished
   — e.g. a 10pm Dodgers game missing from the 6am brief.

   THE FIX: keep everything, flag freshness, DEMOTE stale items in ranking, and
   escalate the window until we have enough stories.
   ========================================================================== */

async function fromGoogleNews(q, cutoff) {
  try {
    const feed = await rss.parseURL(
      'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en');
    return (feed.items || []).map(item => {
      const ts = Date.parse(item.isoDate || item.pubDate || '');
      const parts = (item.title || '').split(' - ');
      const publisher = parts.length > 1 ? parts.pop() : 'News';
      return {
        publisher, title: parts.join(' - ') || item.title, url: item.link,
        publishedAt: isNaN(ts) ? null : new Date(ts).toISOString(),
        snippet: (item.contentSnippet || '').slice(0, 280),
        provider: 'google_news',
        withinWindow: !isNaN(ts) && ts >= cutoff,   // DEMOTE, don't delete
      };
    }).filter(x => x.title && x.url);
  } catch (e) { console.log('google_news error [' + q + ']:', e.message); return []; }
}

async function fromPremiumRSS(feeds, cutoff) {
  const out = [];
  await Promise.allSettled((feeds || []).map(async url => {
    try {
      const feed = await rss.parseURL(url);
      const publisher = publisherFromFeedUrl(url);
      for (const item of (feed.items || []).slice(0, 25)) {
        const ts = Date.parse(item.isoDate || item.pubDate || '');
        out.push({
          publisher, title: item.title, url: item.link,
          publishedAt: isNaN(ts) ? null : new Date(ts).toISOString(),
          snippet: (item.contentSnippet || '').slice(0, 280),
          provider: 'premium_rss', priority: true,
          withinWindow: !isNaN(ts) && ts >= cutoff,   // DEMOTE, don't delete
        });
      }
    } catch (e) { console.log('rss error [' + url + ']:', e.message); }
  }));
  return out.filter(x => x.title && x.url);
}

async function fromNewsData(q, cutoff) {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) return [];
  try {
    const r = await fetchWithRetry(
      'https://newsdata.io/api/1/news?apikey=' + key + '&q=' + encodeURIComponent(q) + '&language=en');
    const d = await r.json();
    return (d.results || []).map(a => {
      const ts = Date.parse(a.pubDate || '');
      return {
        publisher: a.source_id || 'NewsData', title: a.title, url: a.link,
        publishedAt: isNaN(ts) ? null : new Date(ts).toISOString(),
        snippet: (a.description || '').slice(0, 280), provider: 'newsdata',
        withinWindow: !isNaN(ts) && ts >= cutoff,
      };
    }).filter(x => x.title && x.url);
  } catch (e) { console.log('newsdata error:', e.message); return []; }
}

async function fromAlphaVantage() {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetchWithRetry(
      'https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=financial_markets&apikey=' + key);
    const d = await r.json();
    const items = (d.feed || []).slice(0, 8).map(a => ({
      publisher: a.source || 'Market Data', title: a.title, url: a.url,
      publishedAt: new Date().toISOString(),
      snippet: (a.summary || '').slice(0, 280),
      provider: 'alphavantage', priority: true, withinWindow: true,
    }));
    return items.length ? items : null;
  } catch (e) { console.log('alphavantage error:', e.message); return null; }
}

// ESPN: SUPPLEMENTAL score data only. NEVER the sole source for a sports topic.
async function fromESPN(hints) {
  if (!hints || !hints.espn) return [];
  const { sport, league, teamId } = hints.espn;
  try {
    const r = await fetchWithRetry(
      'https://site.api.espn.com/apis/site/v2/sports/' + sport + '/' + league + '/teams/' + teamId + '/schedule',
      {}, { tries: 2, timeoutMs: 8000 });
    const d = await r.json();
    const done = (d.events || []).filter(e =>
      e.competitions && e.competitions[0] && e.competitions[0].status &&
      e.competitions[0].status.type && e.competitions[0].status.type.completed);
    const last = done[done.length - 1];
    if (!last) return [];
    const comp = last.competitions[0];
    const line = (comp.competitors || [])
      .map(c => (c.team && c.team.displayName) + ' ' + (c.score || '')).join(' — ');
    return [{
      publisher: 'ESPN', title: 'Final: ' + line, url: 'https://www.espn.com',
      publishedAt: last.date || new Date().toISOString(),
      snippet: 'Final score. ' + line, provider: 'espn_score',
      priority: true, withinWindow: true,
    }];
  } catch (e) { console.log('espn error:', e.message); return []; }
}

/* ---- one unified retrieval path: EVERY topic queries EVERY source -------- */
// MOCK_MODE returns synthetic sources so the full pipeline (batch -> script ->
// TTS -> assembly) can be exercised without API keys or network access.
function mockSources(topic, n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    publisher: ['Reuters', 'Associated Press', 'BBC News', 'NPR'][i % 4],
    title: topic.label + ' — development ' + (i + 1),
    url: 'https://example.com/' + topic.id + '/' + (i + 1),
    publishedAt: new Date(now - (i + 1) * 3600 * 1000).toISOString(),
    snippet: 'Mock reporting on ' + topic.label + '.',
    provider: 'mock', priority: i < 2, withinWindow: true,
  }));
}

async function retrieveOnce(topic, hours) {
  if (MOCK_MODE) return mockSources(topic, 12);
  const cutoff = Date.now() - hours * 3600 * 1000;
  const queries = topic.queries || [];
  const hints = topic.hints || {};
  const jobs = [ fromPremiumRSS(topic.rss_feeds || [], cutoff) ];
  for (const q of queries) {
    jobs.push(fromGoogleNews(q, cutoff));
    jobs.push(fromNewsData(q, cutoff));
  }
  if (hints.finance) jobs.push(fromAlphaVantage());
  if (hints.sports)  jobs.push(fromESPN(hints));

  const settled = await Promise.allSettled(jobs);
  let items = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value) continue;
    items.push(...(Array.isArray(s.value) ? s.value : [s.value]));
  }
  return dedupeSources(items);
}

// Escalate the window until we have enough stories. Never give up silently.
async function retrieveRobust(topic) {
  const ladder = [topic.window_hours || 24, 48, 72, 168];
  let best = [], usedHours = ladder[0];
  for (const hours of ladder) {
    const items = await retrieveOnce(topic, hours);
    if (items.length > best.length) { best = items; usedHours = hours; }
    const fresh = items.filter(i => i.withinWindow).length;
    if (items.length >= MIN_STORIES && fresh >= Math.min(3, MIN_STORIES)) {
      return finalize(items, hours, false);
    }
  }
  const thin = best.length < MIN_STORIES;
  if (thin) {
    console.warn('[THIN] topic=' + topic.id + ' stories=' + best.length +
                 ' (min=' + MIN_STORIES + ') after escalating to 168h');
  }
  return finalize(best, usedHours, thin);

  function finalize(items, hours, isThin) {
    const ranked = items.slice().sort((a, b) => {
      if (a.withinWindow !== b.withinWindow) return a.withinWindow ? -1 : 1; // fresh leads
      if (!!a.priority !== !!b.priority) return a.priority ? -1 : 1;
      const qa = sourceQualityScore(a), qb = sourceQualityScore(b);
      if (qa !== qb) return qb - qa;
      return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    }).slice(0, MAX_SOURCES);   // was 10 — ten sources cannot fill a 20-min brief
    return { items: ranked, windowUsed: hours, thin: isThin };
  }
}

/* =============================================================================
   SCRIPTING — the Wire Editor (IP posture preserved verbatim from v9.32)
   ========================================================================== */
async function callClaude(prompt, maxTokens, opts = {}) {
  if (MOCK_MODE) {
    // Realistic-length mock so the full pipeline (guards, TTS chunking, duration
    // math, assembly trim) is genuinely exercised without an API key.
    const label = (prompt.match(/news segment of about \d+ words on: (.+)/) || [])[1] || 'the topic';
    const sentence = 'Reuters reports a significant development in ' + label +
      ', with officials confirming the change took effect this week. ';
    return (sentence.repeat(40)).trim();
  }
  const r = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { tries: opts.tries || 2, timeoutMs: opts.timeoutMs || 90000 });
  const d = await r.json();
  return (d.content || []).map(c => c.text || '').join('\n').trim();
}

function sourcesBlock(sources) {
  return (sources || []).map((s, i) =>
    '[' + (i + 1) + '] ' + (s.publisher || 'News') + ' — ' + s.title +
    (s.publishedAt ? ' (' + new Date(s.publishedAt).toUTCString() + ')' : '') +
    (s.snippet ? '\n    ' + s.snippet : '')
  ).join('\n');
}

// Writes ONE topic segment. Segments are stitched at assembly time.
async function writeSegmentScript(topic, sources, targetMin) {
  const targetWords = Math.round(targetMin * 160);
  const prompt =
    'PERSONA: You are "The Wire Editor" — a senior news editor with 20 years in broadcast journalism. ' +
    'You write the way the best wire services and morning shows do: fast, factual, never editorializing, always sourced. ' +
    currentDateContext() + '\n\n' +
    'Write ONE spoken-audio news segment of about ' + targetWords + ' words on: ' + topic.label + '\n\n' +
    'HOW TO REPORT (this is the whole job):\n' +
    '- INVERTED PYRAMID: lead with the single most important, most RECENT concrete development, then supporting detail in descending importance. The listener must get the headline even if they only hear the first sentence. (A trim to half-length must still be coherent.)\n' +
    '- SYNTHESIZE ACROSS SOURCES: never summarize any single article. Combine facts from multiple outlets into one original account.\n' +
    '- REPORT THE FACTS, not another outlet\'s expression of them. Do NOT track the structure, order, framing, angle, or wording of any one source.\n' +
    '- NAMED ATTRIBUTION MID-STORY: weave the source into the sentence — "Reuters reports the central bank raised rates" — not a citation tacked on at the end.\n' +
    '- NEVER fabricate attribution: only credit an outlet for facts that genuinely come from ITS item below.\n' +
    '- If a striking exact quote is essential, keep it UNDER 10 WORDS and attribute it.\n' +
    '- WRITE FOR THE EAR: short sentences, active voice, no headers, no bullet points, no markdown. Spell nothing out that a narrator would not say aloud.\n' +
    '- LENGTH IS A CEILING, NOT A QUOTA. If there is genuinely less news, write LESS. Never pad, never repeat, never speculate to fill time.\n' +
    '- If the source material genuinely contains no real development, say so in one short sentence and stop.\n\n' +
    'SOURCE MATERIAL (published within the last ' + (topic.window_hours || 24) + ' hours where available; ' +
    'items are ranked, freshest and highest-quality first):\n' + sourcesBlock(sources) + '\n\n' +
    'Output ONLY the spoken script text. No preamble, no title, no notes.';
  return callClaude(prompt, Math.max(1200, targetWords * 3), { timeoutMs: 120000, tries: 2 });
}

/* =============================================================================
   TTS — swappable adapter. OpenAI by default (~13x cheaper than ElevenLabs).
   ========================================================================== */
const TTS_LEXICON = {
  meme: 'meem', memes: 'meems',
  thai: 'tie', thais: 'ties',
  niger: 'nee-zhair', nigerien: 'nee-zhair-ee-en', nigeriens: 'nee-zhair-ee-enz',
  qatar: 'kuh-tar', qatari: 'kuh-tar-ee',
};
// Rewrite script text into "spoken form" before synthesis so the voice doesn't
// mangle symbols, numbers, initialisms, or known-tricky words.
function normalizeForTTS(text) {
  let s = String(text || '');
  s = s.replace(/\bU\.\s?S\.\s?A\.?/g, 'United States');
  s = s.replace(/\bU\.\s?S\.(?=[\s,.;:!?)\-]|$)/g, 'United States');
  s = s.replace(/\bU\.\s?K\./g, 'United Kingdom');
  s = s.replace(/\bU\.\s?N\./g, 'United Nations');
  s = s.replace(/\bE\.\s?U\./g, 'European Union');
  s = s.replace(/\s*&\s*/g, ' and ');
  s = s.replace(/\$\s?([\d,]+(?:\.\d+)?)(\s?(?:trillion|billion|million|thousand))?/gi,
    (m, n, sc) => n + (sc || '') + ' dollars');
  s = s.replace(/£\s?([\d,]+(?:\.\d+)?)(\s?(?:trillion|billion|million|thousand))?/gi,
    (m, n, sc) => n + (sc || '') + ' pounds');
  s = s.replace(/€\s?([\d,]+(?:\.\d+)?)(\s?(?:trillion|billion|million|thousand))?/gi,
    (m, n, sc) => n + (sc || '') + ' euros');
  s = s.replace(/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit');
  s = s.replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius');
  s = s.replace(/(\d)\s?°/g, '$1 degrees');
  s = s.replace(/(\d)\s?%/g, '$1 percent');
  s = s.replace(/\b(\d{1,4})\s?-\s?(\d{1,4})\b/g, '$1 to $2');
  s = s.replace(/\bvs\.?(?=\s|$)/gi, 'versus');
  s = s.replace(/\bapprox\./gi, 'approximately');
  s = s.replace(/\bMt\.\s/g, 'Mount ');
  for (const k in TTS_LEXICON) s = s.replace(new RegExp('\\b' + k + '\\b', 'gi'), TTS_LEXICON[k]);
  return s.replace(/\s{2,}/g, ' ').trim();
}

// OpenAI caps input per request; split on sentence boundaries and concat.
function chunkText(s, max = 3800) {
  const sentences = String(s).match(/[^.!?]+[.!?]+(\s|$)/g) || [String(s)];
  const out = []; let cur = '';
  for (const sen of sentences) {
    if ((cur + sen).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += sen;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function ttsOpenAI(text, voice) {
  const r = await fetchWithRetry('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OAK },
    body: JSON.stringify({ model: TTS_MODEL, voice: VOICES[voice] || DEFAULT_VOICE, input: text, response_format: 'mp3' }),
  }, { tries: 3, timeoutMs: 120000 });
  return Buffer.from(await r.arrayBuffer());
}

// Sequential within a segment — parallel TTS caused truncation in v9.x.
async function synthesizeToFile(text, voice, outPath) {
  const spoken = normalizeForTTS(text);
  if (MOCK_MODE) {
    fs.writeFileSync(outPath, Buffer.from('MOCK_AUDIO'));
    return { bytes: 10, durationSec: Math.round(spoken.split(/\s+/).length / 2.6) };
  }
  const chunks = chunkText(spoken);
  const buffers = [];
  for (const c of chunks) {
    const buf = await ttsLimit(() => ttsOpenAI(c, voice));
    if (!buf || !buf.length) throw new Error('empty tts chunk');
    buffers.push(buf);
  }
  const final = Buffer.concat(buffers);
  fs.writeFileSync(outPath, final);
  // ~160 wpm spoken => words/2.67 = seconds
  const durationSec = Math.round(spoken.split(/\s+/).filter(Boolean).length / 2.67);
  return { bytes: final.length, durationSec };
}

/* =============================================================================
   THE NIGHTLY BATCH — generate the catalog once; everyone shares it.
   ========================================================================== */
function cycleDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.BATCH_TZ || 'America/New_York' });
}
const SEGMENT_MIN = Number(process.env.SEGMENT_MIN || 10); // CEILING per topic segment.
// The Wire Editor prompt says "LENGTH IS A CEILING, NOT A QUOTA" — a big World News
// day fills 10 min; a slow Books day writes 5 and stops. We pay for real news only.
const MIN_TOPICS_FOR_LONG = Number(process.env.MIN_TOPICS_FOR_LONG || 2);
const LONG_BRIEF_MIN = Number(process.env.LONG_BRIEF_MIN || 10); // >this needs 2+ topics

async function generateTopic(topic, date, activeVoices) {
  const t0 = Date.now();
  try {
    const { items, windowUsed, thin } = await retrieveRobust(topic);
    if (!items.length) {
      await pool.query(
        `INSERT INTO segments (topic_id, cycle_date, voice, audio_path, script, sources, story_count, status)
         VALUES ($1,$2,'-','','', '[]', 0, 'failed')
         ON CONFLICT (topic_id, cycle_date, voice) DO UPDATE SET status='failed', story_count=0`,
        [topic.id, date]);
      console.error('[FAILED] ' + topic.id + ' — zero sources after full escalation');
      return { topic: topic.id, status: 'failed', stories: 0 };
    }
    const script = await writeSegmentScript(topic, items, SEGMENT_MIN);
    if (!script || script.length < 80) throw new Error('script too short');

    const sources = items.slice(0, 12).map(s => ({
      publisher: s.publisher, title: s.title, url: s.url, publishedAt: s.publishedAt,
    }));
    const dir = path.join(AUDIO_DIR, topic.id, date);
    fs.mkdirSync(dir, { recursive: true });

    for (const voice of (activeVoices && activeVoices.length ? activeVoices : [DEFAULT_VOICE])) {
      const out = path.join(dir, voice + '.mp3');
      const { durationSec } = await synthesizeToFile(script, voice, out);
      await pool.query(
        `INSERT INTO segments (topic_id, cycle_date, voice, audio_path, duration_sec, script, sources, story_count, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (topic_id, cycle_date, voice) DO UPDATE SET
           audio_path=$4, duration_sec=$5, script=$6, sources=$7, story_count=$8, status=$9`,
        [topic.id, date, voice, '/audio/' + topic.id + '/' + date + '/' + voice + '.mp3',
         durationSec, script, JSON.stringify(sources), items.length, thin ? 'thin' : 'ok']);
    }
    console.log('[OK] ' + topic.id + ' stories=' + items.length + ' window=' + windowUsed + 'h voices=' +
                (activeVoices || [DEFAULT_VOICE]).join('/') + ' ' +
                (thin ? 'THIN ' : '') + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    return { topic: topic.id, status: thin ? 'thin' : 'ok', stories: items.length };
  } catch (e) {
    console.error('[FAILED] ' + topic.id + ':', e.message);
    // Failure isolation: yesterday's segment stays servable. Never abort the batch.
    return { topic: topic.id, status: 'failed', error: e.message };
  }
}

async function runBatch() {
  const date = cycleDate();
  console.log('=== BATCH START ' + date + ' ===');
  const { rows: topics } = await pool.query('SELECT * FROM topics WHERE is_live = true');

  // LAZY VOICES: only synthesize voices somebody actually uses. The default voice
  // is always rendered so a brand-new user has something to play immediately.
  // Cuts both cost and batch time ~4x when everyone is on the default.
  const { rows: vrows } = await pool.query('SELECT DISTINCT voice FROM user_briefs');
  const activeVoices = [...new Set([DEFAULT_VOICE, ...vrows.map(r => r.voice)])]
    .filter(v => VOICES[v]);
  console.log('active voices this cycle: ' + activeVoices.join(', ') +
              ' (of ' + Object.keys(VOICES).length + ' offered)');

  const results = await Promise.all(topics.map(t => genLimit(() => generateTopic(t, date, activeVoices))));

  // No pre-assembly. GET /api/brief/today live-assembles per request. Kept only
  // for a health signal — count how many users are affected by this cycle.
  const { rows: briefs } = await pool.query('SELECT COUNT(*)::int AS n FROM user_briefs');
  const userCount = briefs[0] ? briefs[0].n : 0;

  await pruneOldSegments();
  await retireDeadTopics();

  const ok = results.filter(r => r.status === 'ok').length;
  const thin = results.filter(r => r.status === 'thin').length;
  const failed = results.filter(r => r.status === 'failed').length;
  console.log('=== BATCH DONE — ok=' + ok + ' thin=' + thin + ' failed=' + failed +
              ' users=' + userCount + ' ===');
  if (thin || failed) console.warn('ATTENTION: ' + (thin + failed) + ' topic(s) need source work');
  return { date, ok, thin, failed, results };
}

async function pruneOldSegments() {
  const { rows } = await pool.query(
    `SELECT DISTINCT cycle_date FROM segments ORDER BY cycle_date DESC OFFSET $1`, [CATALOG_RETAIN_CYCLES]);
  for (const r of rows) {
    await pool.query('DELETE FROM segments WHERE cycle_date=$1', [r.cycle_date]);
    const d = new Date(r.cycle_date).toISOString().slice(0, 10);
    for (const t of fs.existsSync(AUDIO_DIR) ? fs.readdirSync(AUDIO_DIR) : []) {
      const p = path.join(AUDIO_DIR, t, d);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
}
// Only generate topics somebody actually listens to. Categories always stay live.
async function retireDeadTopics() {
  const { rowCount } = await pool.query(
    `UPDATE topics SET is_live=false WHERE kind <> 'category' AND subscriber_count <= 0 AND is_live=true`);
  if (rowCount) console.log('retired ' + rowCount + ' dead topic(s)');
}

/* =============================================================================
   ASSEMBLY — a brief is a MANIFEST of shared segments. Cost to serve ~= $0.
   ========================================================================== */
async function assembleBrief(brief, date) {
  const topicIds = brief.topic_ids || [];
  if (!topicIds.length) return null;
  const requestedVoice = brief.voice || DEFAULT_VOICE;
  const budgetSec = (brief.length_min || FREE_MAX_LEN) * 60;

  // PER-SEGMENT VOICE FALLBACK. Pull the latest OK segment for each topic in
  // ANY available voice, preferring the user's requested voice, then the
  // default, then anything else. This is the fix for the "4 of 17 topics"
  // bug: when a user switches voices between batches, most of their topics
  // still only have segments in the old voice — we serve those rather than
  // silently drop the topic.
  const q = `SELECT DISTINCT ON (topic_id) topic_id, voice, cycle_date, audio_path,
                    duration_sec, sources, story_count, status,
                    (SELECT label FROM topics t WHERE t.id = segments.topic_id) AS label
               FROM segments
              WHERE topic_id = ANY($1) AND status = 'ok'
              ORDER BY topic_id,
                       CASE WHEN voice = $2 THEN 0
                            WHEN voice = $3 THEN 1
                            ELSE 2 END,
                       cycle_date DESC`;
  const { rows: segs } = await pool.query(q, [topicIds, requestedVoice, DEFAULT_VOICE]);

  const byId = {};
  for (const s of segs) byId[s.topic_id] = s;
  const ordered = topicIds.map(id => byId[id]).filter(Boolean);
  if (!ordered.length) return null;

  // What voice(s) did we actually serve? Report honestly.
  const voicesServed = [...new Set(ordered.map(s => s.voice))];
  const primaryVoice = ordered[0].voice;
  const anyFallback = ordered.some(s => s.voice !== requestedVoice);

  // Proportional trim to the user's budget. Segments are inverted-pyramid, so
  // a trim from the end stays coherent.
  const totalSec = ordered.reduce((a, s) => a + (s.duration_sec || 0), 0);
  const scale = totalSec > budgetSec ? budgetSec / totalSec : 1;

  const items = ordered.map(s => ({
    topic_id: s.topic_id,
    label: s.label,
    url: absolute(s.audio_path),
    duration_sec: s.duration_sec,
    play_sec: Math.max(30, Math.floor((s.duration_sec || 0) * scale)),
    sources: s.sources || [],
    voice: s.voice, // per-segment voice so the client can show mixed-voice state if needed
    status: s.status,
  }));

  // Correct-timezone intro. UTC-noon-parsing was rendering the wrong weekday
  // near midnight boundaries. Anchor to the user's TZ if we have it.
  const tz = brief.timezone || 'America/New_York';
  const introDate = new Date(date + 'T12:00:00');
  const weekday = introDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });

  const total = items.reduce((a, i) => a + i.play_sec, 0);
  const missingTopics = topicIds.length - items.length;

  const manifest = {
    date,
    voice: primaryVoice,
    voice_requested: requestedVoice,
    voice_pending: anyFallback ? 'Some segments are still in your previous voice — your new voice will be fully in place after tomorrow morning\'s update.' : undefined,
    voices_used: voicesServed,
    intro: 'Good morning. It\'s ' + weekday + '. Here\'s your Cast.',
    items,
    requested_topic_count: topicIds.length,
    included_topic_count: items.length,
    missing_topic_count: missingTopics,
    requested_sec: budgetSec,
    actual_sec: total,
  };
  // Only say "news ran short" if we genuinely have all the topics and the
  // aggregate audio is under-budget. Otherwise it's a voice/segment gap, not
  // a news gap — the client should message that differently.
  if (missingTopics === 0 && total < budgetSec * 0.8) {
    manifest.note = 'Today\'s news ran short — this is everything that happened.';
  } else if (missingTopics > 0) {
    manifest.note = missingTopics + ' of your topics don\'t have audio yet — they\'ll be in tomorrow\'s Cast.';
  }
  // (no longer persisted — GET always live-assembles)
  return manifest;
}

/* =============================================================================
   TOPIC SUBSCRIPTION + THE FLYWHEEL
   A custom topic normalizes into the SHARED catalog. The 500th person who wants
   "Dodgers" costs $0 — they subscribe to the topic the 1st person seeded.
   ========================================================================== */
async function subscribeTopic(userId, topicId) {
  const { rowCount } = await pool.query(
    'INSERT INTO topic_subscriptions (user_id, topic_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, topicId]);
  if (rowCount) await pool.query(
    'UPDATE topics SET subscriber_count = subscriber_count + 1, is_live = true WHERE id=$1', [topicId]);
}
async function unsubscribeTopic(userId, topicId) {
  const { rowCount } = await pool.query(
    'DELETE FROM topic_subscriptions WHERE user_id=$1 AND topic_id=$2', [userId, topicId]);
  if (rowCount) await pool.query(
    'UPDATE topics SET subscriber_count = GREATEST(0, subscriber_count - 1) WHERE id=$1', [topicId]);
}

// Returns { topic, created }. Created topics enter TONIGHT's batch → live tomorrow.
async function resolveOrCreateTopic(rawLabel) {
  const normKey = SEED.normalizeTopic(rawLabel);
  const { rows } = await pool.query('SELECT * FROM topics WHERE norm_key=$1', [normKey]);
  if (rows[0]) return { topic: rows[0], created: false };   // SHARED — costs nothing

  const label = String(rawLabel).trim().slice(0, 60);
  const id = 'custom_' + SEED.slug(label) + '_' + crypto.randomBytes(2).toString('hex');
  const queries = [label, label + ' news', label + ' latest', label + ' update'];
  const { rows: ins } = await pool.query(
    `INSERT INTO topics (id, kind, label, norm_key, queries, rss_feeds, window_hours, hints, is_live)
     VALUES ($1,'custom',$2,$3,$4,'[]',48,'{}',true) RETURNING *`,
    [id, label, normKey, JSON.stringify(queries)]);
  console.log('NEW standing topic seeded: ' + id + ' (' + normKey + ')');
  return { topic: ins[0], created: true };
}

/* =============================================================================
   ENDPOINTS
   ========================================================================== */
app.get('/api/health', async (_req, res) => {
  let db = false, dbErr = null;
  try { await pool.query('SELECT 1'); db = true; } catch (e) { dbErr = e.message; }
  res.json({ ok: !bootError && db, version: VERSION, mock: MOCK_MODE, db,
             tts_provider: TTS_PROVIDER, bootError: bootError || undefined,
             dbError: dbErr || undefined });
});

// The pickable menu — categories + the guided-picker taxonomy (no blank box).
// Mint a new anonymous account. The app calls this ONCE on first launch and
// stores { userId, token } in the keychain. `userId` goes to RevenueCat as the
// app_user_id; `token` is the Bearer for every subsequent request.
app.post('/api/auth/register', async (_req, res) => {
  const userId = 'usr_' + crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const tier = DEVELOPER_IDS.includes(userId) ? 'paid' : 'free';
  await pool.query('INSERT INTO users (id, token, tier) VALUES ($1,$2,$3)', [userId, token, tier]);
  res.json({ userId, token, tier });
});

app.get('/api/catalog', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, label, kind, window_hours FROM topics WHERE kind='category' AND is_live=true ORDER BY label`);
  res.json({
    categories: rows,
    leagues: SEED.TEAM_LEAGUES,
    cities: SEED.CITIES,
    follows: SEED.FOLLOW_SEEDS,
  });
});

app.get('/api/me', requireUser(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [req.user.id]);
  res.json({
    userId: req.user.id,     // pass this to Purchases.logIn() BEFORE any purchase
    id: req.user.id,
    tier: req.user.tier,
    limits: {
      maxLengthMin: maxLenFor(req.user),
      maxCategories: isPaid(req.user) ? null : FREE_MAX_CATEGORIES,
      maxCustom: isPaid(req.user) ? PAID_MAX_CUSTOM : 0,
    },
    brief: rows[0] || null,
  });
}));

// Set the brief: ordered topics, length, voice, delivery time.
app.put('/api/brief/config', requireUser(async (req, res) => {
  const u = req.user;
  const { topic_ids = [], length_min = FREE_MAX_LEN, voice = DEFAULT_VOICE, deliver_at = null, timezone } = req.body || {};
  if (!Array.isArray(topic_ids) || !topic_ids.length) return res.status(400).json({ error: 'topics_required' });
  if (!VOICES[voice]) return res.status(400).json({ error: 'bad_voice' });

  const len = Number(length_min) || FREE_MAX_LEN;
  if (len > maxLenFor(u))
    return res.status(403).json({ error: 'length_locked', requiredTier: 'paid', maxLengthMin: maxLenFor(u) });
  if (!isPaid(u) && topic_ids.length > FREE_MAX_CATEGORIES)
    return res.status(403).json({ error: 'category_limit', requiredTier: 'paid', max: FREE_MAX_CATEGORIES });
  // A brief is a BRIEF: long briefs need at least 2 topics. One topic cannot honestly
  // fill 20 minutes daily without padding, and padding is what makes AI content worthless.
  if (len > LONG_BRIEF_MIN && topic_ids.length < MIN_TOPICS_FOR_LONG)
    return res.status(400).json({
      error: 'need_more_topics', minTopics: MIN_TOPICS_FOR_LONG, forLengthOver: LONG_BRIEF_MIN,
      message: 'Briefs longer than ' + LONG_BRIEF_MIN + ' minutes need at least ' +
               MIN_TOPICS_FOR_LONG + ' topics.' });
  if (!isPaid(u) && deliver_at)
    return res.status(403).json({ error: 'scheduling_locked', requiredTier: 'paid' });

  const { rows: valid } = await pool.query('SELECT id FROM topics WHERE id = ANY($1)', [topic_ids]);
  const validIds = valid.map(r => r.id);
  const ordered = topic_ids.filter(id => validIds.includes(id));
  if (!ordered.length) return res.status(400).json({ error: 'no_valid_topics' });

  const { rows: prev } = await pool.query('SELECT topic_id FROM topic_subscriptions WHERE user_id=$1', [u.id]);
  for (const p of prev) if (!ordered.includes(p.topic_id)) await unsubscribeTopic(u.id, p.topic_id);
  for (const id of ordered) await subscribeTopic(u.id, id);

  await pool.query(
    `INSERT INTO user_briefs (user_id, topic_ids, length_min, voice, deliver_at, timezone, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (user_id) DO UPDATE SET
       topic_ids=$2, length_min=$3, voice=$4, deliver_at=$5, timezone=COALESCE($6, user_briefs.timezone), updated_at=now()`,
    [u.id, JSON.stringify(ordered), len, voice, deliver_at, timezone || null]);

  // Assemble immediately from the existing catalog so they hear it now.
  const { rows: b } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [u.id]);
  const manifest = await assembleBrief(b[0], cycleDate());
  res.json({ ok: true, topics: ordered, length_min: len, voice, manifest });
}));

// PAID: add one of up to 3 custom topics. Normalizes into the shared catalog.
app.post('/api/brief/custom-topic', requireUser(async (req, res) => {
  const u = req.user;
  if (!isPaid(u)) return res.status(403).json({ error: 'custom_locked', requiredTier: 'paid' });
  const label = String((req.body || {}).label || '').trim();
  if (label.length < 2 || label.length > 60) return res.status(400).json({ error: 'bad_label' });

  const { rows: mine } = await pool.query(
    `SELECT t.id FROM topic_subscriptions s JOIN topics t ON t.id=s.topic_id
      WHERE s.user_id=$1 AND t.kind NOT IN ('category')`, [u.id]);
  if (mine.length >= PAID_MAX_CUSTOM)
    return res.status(403).json({ error: 'custom_limit', max: PAID_MAX_CUSTOM });

  const { topic, created } = await resolveOrCreateTopic(label);
  await subscribeTopic(u.id, topic.id);

  const { rows: b } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [u.id]);
  if (b[0]) {
    const ids = (b[0].topic_ids || []).concat([topic.id]);
    await pool.query('UPDATE user_briefs SET topic_ids=$2, updated_at=now() WHERE user_id=$1',
      [u.id, JSON.stringify([...new Set(ids)])]);
  }
  res.json({
    ok: true, topic: { id: topic.id, label: topic.label },
    created,
    // Honest UX contract: a brand-new topic joins tonight's batch.
    available: created ? 'tomorrow_morning' : 'now',
    message: created
      ? 'We\'re adding "' + topic.label + '" — it\'ll be in your brief tomorrow morning.'
      : '"' + topic.label + '" added to your brief.',
  });
}));

app.delete('/api/brief/custom-topic/:id', requireUser(async (req, res) => {
  await unsubscribeTopic(req.user.id, req.params.id);
  const { rows: b } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [req.user.id]);
  if (b[0]) {
    const ids = (b[0].topic_ids || []).filter(x => x !== req.params.id);
    await pool.query('UPDATE user_briefs SET topic_ids=$2, updated_at=now() WHERE user_id=$1',
      [req.user.id, JSON.stringify(ids)]);
  }
  res.json({ ok: true });
}));

// Today's brief: the manifest of shared segments + source links.
app.get('/api/brief/today', requireUser(async (req, res) => {
  // ALWAYS LIVE-ASSEMBLE. No cache. A stale daily_briefs row was previously
  // being served in place of a freshly-configured Cast; assembly is cheap
  // (~50ms, DB-only, no generation), so there's no reason to cache.
  const date = cycleDate();
  const { rows: b } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [req.user.id]);
  if (!b[0] || !(b[0].topic_ids || []).length) return res.status(404).json({ error: 'no_brief_configured' });
  const manifest = await assembleBrief(b[0], date);
  if (!manifest || !manifest.items || !manifest.items.length) {
    return res.status(503).json({ error: 'catalog_not_ready',
      message: 'Your Cast is being prepared — check back in a moment.' });
  }
  res.json({ ok: true, ...manifest });
}));

app.use('/audio', express.static(AUDIO_DIR, { maxAge: '7d' }));

/* ---- billing (carried over; RevenueCat identity fix preserved) ----------- */
function tierFromRevenueCat(ev) {
  const ents = (ev && ev.entitlement_ids) || [];
  if (ents.length) return 'paid';
  return 'free';
}
app.post('/api/revenuecat/webhook', async (req, res) => {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (RC_WEBHOOK && auth !== RC_WEBHOOK) return res.status(403).json({ error: 'forbidden' });
  const ev = (req.body || {}).event || {};
  // Prefer a usr_ id from the alias list — the anonymous-ID bug fix.
  const candidates = [ev.app_user_id, ...(ev.aliases || []), ev.original_app_user_id].filter(Boolean);
  const target = candidates.find(id => /^usr_/.test(id)) || candidates[0];
  if (!target) return res.json({ ok: true, skipped: 'no_id' });
  const tier = tierFromRevenueCat(ev);
  await pool.query(
    'INSERT INTO users (id, tier) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET tier=$2', [target, tier]);
  console.log('revenuecat ' + ev.type + ' -> ' + target + ' tier=' + tier);
  res.json({ ok: true, user: target, tier });
});
app.get('/api/revenuecat/webhook', (_req, res) => res.json({ ok: true, note: 'POST expected' }));

app.post('/api/billing/refresh', requireUser(async (req, res) => {
  if (!RC_SECRET) return res.json({ ok: true, tier: req.user.tier, note: 'no_rc_key' });
  try {
    const r = await fetchWithRetry('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(req.user.id),
      { headers: { Authorization: 'Bearer ' + RC_SECRET } }, { tries: 2, timeoutMs: 10000 });
    const d = await r.json();
    const ents = ((d.subscriber || {}).entitlements) || {};
    const active = Object.keys(ents).filter(k => !ents[k].expires_date || new Date(ents[k].expires_date) > new Date());
    const tier = active.length ? 'paid' : 'free';
    await pool.query('UPDATE users SET tier=$2 WHERE id=$1', [req.user.id, tier]);
    res.json({ ok: true, tier });
  } catch (e) { res.status(502).json({ error: 'rc_failed', message: e.message }); }
}));

/* ---- admin -------------------------------------------------------------- */
app.post('/api/admin/batch/run', requireAdmin(async (_req, res) => {
  res.json({ ok: true, started: true });   // respond immediately; batch runs on
  runBatch().catch(e => console.error('batch error:', e));  // the server, not the request
}));

// The health metric that would have caught the Dodgers bug on night one.
app.get('/api/admin/catalog/health', requireAdmin(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (s.topic_id) s.topic_id, t.label, t.kind, t.window_hours,
            s.story_count, s.status, s.cycle_date, t.subscriber_count
       FROM segments s JOIN topics t ON t.id=s.topic_id
      ORDER BY s.topic_id, s.cycle_date DESC`);
  const thin = rows.filter(r => r.status !== 'ok');
  res.json({
    cycle: cycleDate(),
    total: rows.length,
    ok: rows.filter(r => r.status === 'ok').length,
    thin: rows.filter(r => r.status === 'thin').length,
    failed: rows.filter(r => r.status === 'failed').length,
    needs_attention: thin,
    topics: rows.sort((a, b) => a.story_count - b.story_count),
  });
}));

app.get('/api/admin/topics', requireAdmin(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, kind, label, norm_key, window_hours, subscriber_count, is_live FROM topics ORDER BY kind, label');
  res.json({ count: rows.length, topics: rows });
}));

// Audition a voice on a REAL segment without running a full batch.
// GET /api/admin/voice-sample?topic=world_news&voice=onyx
app.get('/api/admin/voice-sample', requireAdmin(async (req, res) => {
  const topicId = req.query.topic || 'world_news';
  const voice = req.query.voice || DEFAULT_VOICE;
  if (!VOICES[voice]) return res.status(400).json({ error: 'bad_voice', available: Object.keys(VOICES) });
  const { rows } = await pool.query(
    `SELECT script, cycle_date FROM segments WHERE topic_id=$1 AND status<>'failed'
     ORDER BY cycle_date DESC LIMIT 1`, [topicId]);
  if (!rows[0]) return res.status(404).json({ error: 'no_segment_for_topic', topic: topicId });
  const date = new Date(rows[0].cycle_date).toISOString().slice(0, 10);
  const dir = path.join(AUDIO_DIR, topicId, date);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, voice + '.mp3');
  const { durationSec } = await synthesizeToFile(rows[0].script, voice, out);
  const url = '/audio/' + topicId + '/' + date + '/' + voice + '.mp3';
  await pool.query(
    `INSERT INTO segments (topic_id, cycle_date, voice, audio_path, duration_sec, script, sources, story_count, status)
     SELECT topic_id, cycle_date, $3, $4, $5, script, sources, story_count, status
       FROM segments WHERE topic_id=$1 AND cycle_date=$2 LIMIT 1
     ON CONFLICT (topic_id, cycle_date, voice) DO UPDATE SET audio_path=$4, duration_sec=$5`,
    [topicId, date, voice, url, durationSec]);
  res.json({ ok: true, topic: topicId, voice, durationSec, url: absolute(url) });
}));

app.get('/api/diag/tts', requireAdmin(async (_req, res) => {
  try {
    const p = path.join(AUDIO_DIR, '_diag.mp3');
    const { bytes } = await synthesizeToFile('MyCast text to speech diagnostic. The S&P 500 rose 1.4%.', DEFAULT_VOICE, p);
    res.json({ ok: true, provider: TTS_PROVIDER, model: TTS_MODEL, bytes });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
}));

/* ---- scheduler ---------------------------------------------------------- */
// Fire the batch once per day at BATCH_HOUR in BATCH_TZ.
const BATCH_HOUR = Number(process.env.BATCH_HOUR || 3);
let lastBatchDate = null;
setInterval(async () => {
  const tz = process.env.BATCH_TZ || 'America/New_York';
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  const date = cycleDate();
  if (hour === BATCH_HOUR && lastBatchDate !== date) {
    lastBatchDate = date;
    console.log('scheduled batch firing for ' + date);
    try { await runBatch(); } catch (e) { console.error('scheduled batch error:', e); }
  }
}, 5 * 60 * 1000);

/* ---- boot --------------------------------------------------------------- */
let bootError = null;
initDb()
  .catch(e => {
    // Do NOT exit. A dead process gives Railway's opaque "Application failed to
    // respond" with no way to diagnose. Stay up and report the error on /api/health.
    bootError = e.message;
    console.error('DB INIT FAILED (server still starting so you can diagnose):', e);
  })
  .finally(() => {
    app.listen(PORT, () => console.log('MyCast ' + VERSION + ' on port ' + PORT +
      ' (tts=' + TTS_PROVIDER + '/' + TTS_MODEL + (MOCK_MODE ? ', MOCK' : '') +
      (bootError ? ', DB_ERROR' : '') + ')'));
  });

module.exports = { app, runBatch, retrieveRobust, normalizeForTTS, assembleBrief, resolveOrCreateTopic, subscribeTopic, pool };
