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

const VERSION = 'v2.1';
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

/* ---------------------------------------------------------------- DEPTH TIERS
   v2.1. A user picks a DEPTH per topic. Every tier is a complete, pre-rendered
   file that plays start to finish -- there is no play_sec and nothing is ever
   trimmed mid-stream. cost_sec is what the client's budget meter charges for a
   topic at that depth; it is served from /api/catalog so the app never
   hardcodes it. -------------------------------------------------------- */
const TIERS = {
  headlines: { id: 'headlines', label: 'Headlines', cost_sec: Number(process.env.TIER_HEADLINES_SEC || 45),  blurb: 'Top stories, fast' },
  expanded:  { id: 'expanded',  label: 'Expanded',  cost_sec: Number(process.env.TIER_EXPANDED_SEC  || 180), blurb: 'Context and detail' },
  full:      { id: 'full',      label: 'Full',      cost_sec: Number(process.env.TIER_FULL_SEC      || 300), blurb: 'The whole picture' },
};
const TIER_ORDER   = ['headlines', 'expanded', 'full'];
const DEFAULT_TIER = 'headlines';
const WORDS_PER_SEC = 160 / 60;   // ~160 wpm narration

// Soft server-side trial. No card, not an Apple introductory offer, no
// RevenueCat dependency -- new users simply get a bigger budget for a week.
// Length only: the category limit stays put, so a trial user cannot fill the
// extra time without discovering the depth controls.
const TRIAL_DAYS    = Number(process.env.TRIAL_DAYS    || 7);
const TRIAL_MAX_LEN = Number(process.env.TRIAL_MAX_LEN || 10);

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
    -- v2.1: a segment now exists once per DEPTH TIER. The old uniqueness on
    -- (topic_id, cycle_date, voice) is replaced so three tiers can coexist.
    ALTER TABLE segments ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'full';
    ALTER TABLE segments ADD COLUMN IF NOT EXISTS script_prefix_chars int;
    ALTER TABLE segments DROP CONSTRAINT IF EXISTS segments_topic_id_cycle_date_voice_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_seg_unique_tier
      ON segments (topic_id, cycle_date, voice, tier);
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      token text,
      tier text NOT NULL DEFAULT 'free',
      email text,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
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
    -- v2.1 depth selection. topic_depths holds only OVERRIDES; anything absent
    -- inherits default_depth. This storage supports both a global-with-overrides
    -- UI and a pure per-topic UI with no server change.
    ALTER TABLE user_briefs ADD COLUMN IF NOT EXISTS topic_depths  jsonb DEFAULT '{}';
    ALTER TABLE user_briefs ADD COLUMN IF NOT EXISTS default_depth text DEFAULT 'headlines';
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
const inTrial = u => !!u && !isPaid(u) && !!u.created_at &&
  (Date.now() - new Date(u.created_at).getTime()) < TRIAL_DAYS * 86400000;
const trialDaysLeft = u => inTrial(u)
  ? Math.max(0, Math.ceil(TRIAL_DAYS - (Date.now() - new Date(u.created_at).getTime()) / 86400000))
  : null;
const maxLenFor = u => isPaid(u) ? PAID_MAX_LEN : (inTrial(u) ? TRIAL_MAX_LEN : FREE_MAX_LEN);

// Resolve a user's chosen depth for a topic: explicit override, else default.
function depthOf(brief, topicId) {
  const d = (brief && brief.topic_depths) || {};
  if (TIERS[d[topicId]]) return d[topicId];
  const def = brief && brief.default_depth;
  return TIERS[def] ? def : DEFAULT_TIER;
}

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
  const hWords = Math.round(TIERS.headlines.cost_sec * WORDS_PER_SEC);
  const eWords = Math.round(TIERS.expanded.cost_sec  * WORDS_PER_SEC);
  const prompt =
    'You are writing a single news segment that will be stitched together with other segments to form one continuous audio brief. ' +
    'A separate intro line ("Here\'s your Cast, [day]") is played before all segments, and short transitions are played between them. ' +
    'Your segment is one piece of a whole — write it as MID-SHOW copy, never as a standalone piece.\n\n' +

    'TOPIC: ' + topic.label + '\n' +
    'TARGET LENGTH: about ' + targetWords + ' words (this is a CEILING — write less if there is less news).\n\n' +

    'DEPTH MARKERS — REQUIRED:\n' +
    'Listeners choose how deep to go on each topic, and the shorter versions are PREFIXES of this script. ' +
    'Insert these two markers, each on its own line, immediately AFTER a sentence-ending period:\n' +
    '  [[TIER1]] after the last sentence of a roughly ' + hWords + '-word version (the essential headlines).\n' +
    '  [[TIER2]] after the last sentence of a roughly ' + eWords + '-word version (headlines plus context).\n' +
    'Everything before [[TIER1]] must stand alone as a complete mini-segment. ' +
    'Everything before [[TIER2]] must stand alone as a complete medium segment. ' +
    'NEVER place a marker mid-sentence. If the news genuinely runs shorter than ' + hWords + ' words, ' +
    'write what exists and put both markers at the very end.\n\n' +

    'ABSOLUTE RULES — VIOLATING ANY OF THESE MAKES THE SEGMENT UNUSABLE:\n' +
    '1. DO NOT open with a greeting. FORBIDDEN opening words/phrases include: "Good morning", "Good afternoon", "Good evening", "Hello", "Hi", "Welcome", "Welcome back", "Thanks for listening", "Today\'s Cast", "In today\'s", "Here\'s what\'s happening", "Top stories", "Coming up", "Let\'s start with", "Let\'s begin".\n' +
    '2. DO NOT mention the date, day of the week, current time, or any temporal frame like "this morning", "tonight", "today", "this week". If timing matters to a story, use specifics like "Tuesday\'s Fed meeting" — never a generic time reference.\n' +
    '3. DO NOT include a closing line. No "that\'s the news on X", no "more on that later", no "back after this". End on the last fact.\n' +
    '4. DO NOT reference other topics or segments. Do not say "in other news", "turning to", "speaking of". This segment does not know what comes before or after it.\n' +
    '5. DO NOT address the listener directly (no "you", no "we\'ll", no "stay tuned").\n\n' +

    'WRONG OPENING (do not do this):\n' +
    '  "Good morning. Today in markets, the S&P closed higher..."\n' +
    '  "Welcome back. Here\'s the latest on the Fed..."\n' +
    'RIGHT OPENING (do this):\n' +
    '  "The S&P closed at 5,832, up 1.4 percent on the day, after the Fed held rates steady..."\n' +
    '  "Federal prosecutors filed new charges against..."\n\n' +

    'HOW TO REPORT:\n' +
    '- START WITH A FACT. First sentence names a subject and states a concrete development. No framing, no throat-clearing.\n' +
    '- INVERTED PYRAMID: the most important development first, supporting detail in descending order. A trim to half-length must still make sense.\n' +
    '- SYNTHESIZE ACROSS SOURCES: never summarize a single article. Combine facts from multiple outlets into one original account.\n' +
    '- REPORT THE FACTS, not another outlet\'s expression of them. Do not mirror the structure, framing, or wording of any single source.\n' +
    '- NAMED ATTRIBUTION MID-STORY: "Reuters reports the central bank raised rates" — not a citation tacked on.\n' +
    '- NEVER fabricate attribution: only credit an outlet for facts that genuinely came from its item below.\n' +
    '- If a striking exact quote is essential, keep it UNDER 10 WORDS and attribute it.\n' +
    '- WRITE FOR THE EAR: short sentences, active voice, no headers or bullets or markdown.\n' +
    '- NEVER PAD. If the news genuinely runs short, write less. Do not repeat, do not speculate.\n\n' +

    'SOURCE MATERIAL (freshest and highest-quality first, published within the last ' + (topic.window_hours || 24) + ' hours where available):\n' +
    sourcesBlock(sources) + '\n\n' +

    'Output ONLY the spoken script text. No preamble, no title, no notes, no metadata. Start with the first news sentence.';
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
/* ------------------------------------------------- EXACT MP3 DURATION (no deps)
   duration_sec must be MEASURED, not estimated: Rork requires +/-1s and the old
   bytes/4000 heuristic drifts. music-metadata was rejected because current
   versions are ESM-only and this package is "type": "commonjs".

   This walks real MPEG frame headers and returns totalSamples / sampleRate,
   which is exact for CBR and correct for VBR. Validated against ffprobe across
   bitrates, sample rates and ID3-tagged files: worst error 0.026s.
   ------------------------------------------------------------------------- */
const MP3_BITRATES = {
  1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320], // MPEG1 Layer III
  2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],     // MPEG2/2.5 Layer III
};
const MP3_SAMPLERATES = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };

function mp3DurationSec(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }
  let off = 0;
  // Skip an ID3v2 container if present (28-bit syncsafe length).
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    off = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
    if (buf[5] & 0x10) off += 10; // footer present
  }
  let frames = 0, totalSamples = 0, sampleRate = 0;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) { off++; continue; }
    const verBits = (buf[off + 1] >> 3) & 0x03;   // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layer   = (buf[off + 1] >> 1) & 0x03;   // 1 = Layer III
    const brIdx   = (buf[off + 2] >> 4) & 0x0f;
    const srIdx   = (buf[off + 2] >> 2) & 0x03;
    const pad     = (buf[off + 2] >> 1) & 0x01;
    if (verBits === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { off++; continue; }
    const bitrate = (verBits === 3 ? MP3_BITRATES[1] : MP3_BITRATES[2])[brIdx] * 1000;
    const sr = MP3_SAMPLERATES[verBits][srIdx];
    if (!bitrate || !sr) { off++; continue; }
    const samplesPerFrame = verBits === 3 ? 1152 : 576;
    const frameLen = Math.floor((samplesPerFrame / 8) * bitrate / sr) + pad;
    if (frameLen < 4) { off++; continue; }
    frames++; totalSamples += samplesPerFrame; sampleRate = sr;
    off += frameLen;
  }
  if (!frames || !sampleRate) return null;
  return totalSamples / sampleRate;
}

/* ------------------------------------------------------- SCRIPT -> DEPTH TIERS
   One script per topic per night. Tiers are PREFIXES of it, so upgrading a
   topic from Headlines to Full gives you more of the same reporting rather than
   a different account of it.

   Claude is asked to place [[TIER1]] / [[TIER2]] markers on sentence
   boundaries. If it doesn't comply we fall back to accumulating whole sentences
   up to each tier's word budget -- either way a tier NEVER ends mid-sentence.
   ------------------------------------------------------------------------- */
// Sentence boundaries in real news copy. Naive splitting on [.!?] breaks on
// closing quotes ('...forward for the state." Analysts...') and on
// abbreviations ('J.P. Morgan', 'Jan. 4', 'Dr. Lee'), which would let a tier
// end mid-sentence -- the exact failure this release exists to eliminate.
const ABBREV_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sen|rep|gov|gen|col|lt|sgt|st|jr|sr|vs|etc|inc|ltd|co|corp|dept|est|approx|no|fig|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|u\.s|u\.k|e\.g|i\.e|a\.m|p\.m)\.$/i;
const CLOSERS = '"\')]\u201d\u2019';
const OPENERS = '"\'(\u201c\u2018';

// Returns [start, end] character spans over the NORMALIZED text.
function sentenceSpans(t) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '.' && t[i] !== '!' && t[i] !== '?') continue;
    let j = i + 1;
    while (j < t.length && CLOSERS.indexOf(t[j]) >= 0) j++;   // absorb closing quotes
    if (j >= t.length) break;
    if (t[j] !== ' ') continue;                                // not a boundary
    const k = j + 1;
    if (k >= t.length) break;
    // A real sentence starts with a capital, a digit, or an opening quote.
    if (!(OPENERS.indexOf(t[k]) >= 0 || /[A-Z0-9]/.test(t[k]))) continue;
    const chunk = t.slice(start, j);
    // Abbreviation or a lone initial ("J." in "J.P.") is not a sentence end.
    if (ABBREV_END.test(chunk) || /(?:^|\s)[A-Za-z]\.$/.test(chunk)) continue;
    spans.push([start, j]);
    start = k;
    i = k - 1;
  }
  if (start < t.length) spans.push([start, t.length]);
  return spans;
}

function splitSentences(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return sentenceSpans(t).map(([a, b]) => t.slice(a, b).trim()).filter(Boolean);
}

/* ------------------------------------------------------- SCRIPT -> DEPTH TIERS
   One script per topic per night. Tiers are PREFIXES of it, so upgrading a
   topic from Headlines to Full gives more of the same reporting rather than a
   different account of it.

   Claude is asked to place [[TIER1]] / [[TIER2]] markers on sentence
   boundaries. Markers are SNAPPED to the nearest real boundary and validated;
   if they're missing or unusable we fall back to accumulating whole sentences
   up to each tier's word budget. Every tier is produced by slicing the SAME
   normalized string, so a shorter tier is always an exact prefix of a longer
   one -- and can never end mid-sentence.
   ------------------------------------------------------------------------- */
function splitScriptIntoTiers(script) {
  const raw = String(script || '').trim();
  const markerRe = /\[\[TIER([12])\]\]/g;

  // Where do the markers sit, measured in the normalized text?
  const marks = {};
  let cleaned = '', last = 0, m;
  while ((m = markerRe.exec(raw)) !== null) {
    cleaned += raw.slice(last, m.index);
    marks[m[1]] = cleaned.replace(/\s+/g, ' ').trim().length;
    last = m.index + m[0].length;
  }
  cleaned += raw.slice(last);
  const full = cleaned.replace(/\s+/g, ' ').trim();
  if (!full) return { headlines: '', expanded: '', full: '', marked: false };

  const spans = sentenceSpans(full);
  const ends = spans.map(sp => sp[1]);

  // Snap a marker offset DOWN to the nearest sentence end, so a marker dropped
  // mid-sentence by the model cannot produce a mid-sentence cut.
  const snap = off => {
    let best = 0;
    for (const e of ends) { if (e <= off + 2) best = e; else break; }
    return best;
  };

  const wordsFor = sec => Math.round(sec * WORDS_PER_SEC);
  const byBudget = target => {
    let n = 0, end = 0;
    for (const [a, b] of spans) {
      const w = full.slice(a, b).split(/\s+/).filter(Boolean).length;
      if (n && n + w > target) break;
      n += w; end = b;
    }
    return end || full.length;
  };

  let h = marks['1'] ? snap(marks['1']) : 0;
  let e = marks['2'] ? snap(marks['2']) : 0;
  const usedMarkers = h > 0 && e >= h;
  if (!usedMarkers) {
    h = byBudget(wordsFor(TIERS.headlines.cost_sec));
    e = byBudget(wordsFor(TIERS.expanded.cost_sec));
  }
  if (e < h) e = h;

  return {
    headlines: full.slice(0, h).trim() || full,
    expanded:  full.slice(0, e).trim() || full,
    full,
    marked: usedMarkers,
  };
}

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
  // v2.1: MEASURE the file. Estimation (word count, then bytes/4000) is what
  // put duration_sec out of tolerance. Fall back to the byte estimate only if
  // the parser can't find frames, which would mean a malformed file.
  const measured = mp3DurationSec(outPath);
  const wordEstSec = Math.round(spoken.split(/\s+/).filter(Boolean).length / 2.67);
  const byteEstSec = Math.round(final.length / 4000);
  const fallback = (byteEstSec > 5 && byteEstSec < wordEstSec * 2.5) ? byteEstSec : wordEstSec;
  if (measured == null) console.warn('mp3 duration parse failed, estimating:', outPath);
  const durationSec = measured != null ? Math.round(measured) : fallback;
  return { bytes: final.length, durationSec, exact: measured != null };
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
        `INSERT INTO segments (topic_id, cycle_date, voice, tier, audio_path, script, sources, story_count, status)
         VALUES ($1,$2,'-','full','','', '[]', 0, 'failed')
         ON CONFLICT (topic_id, cycle_date, voice, tier) DO UPDATE SET status='failed', story_count=0`,
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

    // Split once, reuse for every voice.
    const tiers = splitScriptIntoTiers(script);
    if (!tiers.marked) console.warn('[tier-fallback] ' + topic.id + ' — no markers, split by sentence budget');

    for (const voice of (activeVoices && activeVoices.length ? activeVoices : [DEFAULT_VOICE])) {
      // SEQUENTIAL. Concurrent TTS previously produced truncated ~23s episodes.
      // Files are content-addressed on the tier TEXT, so when a topic has less
      // news than a tier allows and two tiers come out identical, they share a
      // single synthesis and a single file. That is what makes depth a CEILING
      // rather than a quota to pad up to.
      const renderedByHash = {};
      for (const tierId of TIER_ORDER) {
        const text = tiers[tierId];
        if (!text || text.length < 40) continue;
        const h = crypto.createHash('sha1').update(text).digest('hex').slice(0, 6);
        if (!renderedByHash[h]) {
          const rel = '/audio/' + topic.id + '/' + date + '/' + voice + '.' + h + '.mp3';
          const out = path.join(dir, voice + '.' + h + '.mp3');
          const { durationSec, exact } = await synthesizeToFile(text, voice, out);
          renderedByHash[h] = { rel, durationSec, exact };
        }
        const r = renderedByHash[h];
        await pool.query(
          `INSERT INTO segments (topic_id, cycle_date, voice, tier, audio_path, duration_sec,
                                 script, script_prefix_chars, sources, story_count, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (topic_id, cycle_date, voice, tier) DO UPDATE SET
             audio_path=$5, duration_sec=$6, script=$7, script_prefix_chars=$8,
             sources=$9, story_count=$10, status=$11`,
          [topic.id, date, voice, tierId, r.rel, r.durationSec, text, text.length,
           JSON.stringify(sources), items.length, thin ? 'thin' : 'ok']);
      }
      const uniq = Object.keys(renderedByHash).length;
      console.log('  ' + topic.id + '/' + voice + ': ' + uniq + ' file(s) for ' +
                  TIER_ORDER.length + ' tiers' + (uniq < TIER_ORDER.length ? ' (shared — short news)' : ''));
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
// Short spoken transition between topics. Synthesized once per (topic, voice, date).
// Cached in AUDIO_DIR so we only synthesize once. Kept intentionally short and
// consistent so the whole brief feels like a produced show rather than jump-cuts
// between independent scripts.
//
// BUG B FIX (July 2026): transitions were cached at STABLE filenames behind a
// 500-byte guard. 500 bytes is ~0.125s of audio, so a truncated synth ("the
// unintelligible blip" in Rork's report) passed validation and was then pinned
// at that URL forever -- it could never self-heal on a later request.
//
// Two changes:
//   1. Content-address the filename with a hash of (text + voice), matching the
//      scheme already used for segments. New copy => new URL, so bytes at a
//      published URL never change (Rork acceptance criterion #4).
//   2. Validate against EXPECTED size rather than a flat floor, both on cache
//      hit and immediately after synthesis, with one retry. Undersized output
//      is treated as a failure instead of being cached.
//
const TTS_BYTES_PER_SEC = 4000;          // OpenAI tts-1 mp3 ~= 32kbps
const TRANSITION_MIN_BYTES_ABS = 2500;   // hard floor (~0.6s) -- catches blips

// Expected byte size of synthesized speech, from word count.
function expectedTtsBytes(text) {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.67) * TTS_BYTES_PER_SEC);
}

// A file is acceptable if it clears the absolute floor AND is at least 60% of
// the size we predicted for its script. The 60% band tolerates normal TTS
// pacing variance while still rejecting genuine truncation.
function ttsFileLooksComplete(filePath, text) {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  const need = Math.max(TRANSITION_MIN_BYTES_ABS, Math.round(expectedTtsBytes(text) * 0.6));
  return size >= need;
}

async function ensureTransitionAudio(label, voice, date) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const text = 'Next up: ' + label + '.';

  // Content-addressed: hash covers the spoken text and the voice, so any change
  // to transition copy publishes a new URL instead of mutating an existing one.
  const transHash = crypto.createHash('sha1').update(text + '|' + voice).digest('hex').slice(0, 6);

  const dir = path.join(AUDIO_DIR, '_transitions', date);
  fs.mkdirSync(dir, { recursive: true });
  const filename = slug + '__' + voice + '.' + transHash + '.mp3';
  const outPath = path.join(dir, filename);
  const urlPath = '/audio/_transitions/' + date + '/' + filename;

  // Cache hit only counts if the cached bytes actually look complete.
  if (ttsFileLooksComplete(outPath, text)) {
    return { url: urlPath, durationSec: Math.round(mp3DurationSec(outPath) || 0) };
  }

  // A file that exists but failed validation is a poisoned cache entry. Remove
  // it so the retry below writes clean bytes.
  if (fs.existsSync(outPath)) {
    console.warn('transition cache REJECTED (undersized), regenerating:', filename,
      fs.statSync(outPath).size + 'B');
    try { fs.unlinkSync(outPath); } catch (_) {}
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await synthesizeToFile(text, voice, outPath);
      if (ttsFileLooksComplete(outPath, text)) return { url: urlPath, durationSec: r.durationSec };
      console.warn('transition synth undersized (attempt ' + attempt + '):', filename,
        (fs.existsSync(outPath) ? fs.statSync(outPath).size : 0) + 'B');
      try { fs.unlinkSync(outPath); } catch (_) {}
    } catch (e) {
      console.error('transition synth failed (attempt ' + attempt + '):', e.message);
    }
  }

  // Returning null makes assembleBrief emit no transition for this item, which
  // plays as a clean segment-to-segment cut. Strictly better than a blip.
  console.error('transition GAVE UP after 2 attempts:', filename);
  return null;
}

// Personalized intro audio, generated on demand per (user, voice, date).
// Cached in AUDIO_DIR so we only synthesize once per day per user per voice.
async function ensureIntroAudio(user, voice, date, tz) {
  const nameSlug = user && user.name ? user.name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '') : 'anon';
  const dir = path.join(AUDIO_DIR, '_intros', date);
  fs.mkdirSync(dir, { recursive: true });
  const weekday = new Date(date + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz || 'America/New_York' });
  const firstName = user && user.name ? user.name.trim().split(/\s+/)[0] : null;
  const text = firstName
    ? 'Hey ' + firstName + ', here\'s your Cast. ' + weekday + '.'
    : 'Here\'s your Cast. ' + weekday + '.';

  const introHash = crypto.createHash('sha1').update(text + '|' + voice).digest('hex').slice(0, 6);
  const filename = nameSlug + '__' + voice + '.' + introHash + '.mp3';
  const outPath = path.join(dir, filename);
  const urlPath = '/audio/_intros/' + date + '/' + filename;

  if (ttsFileLooksComplete(outPath, text)) {
    return { url: urlPath, durationSec: Math.round(mp3DurationSec(outPath) || 0) };
  }
  if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch (_) {} }

  try {
    const r = await synthesizeToFile(text, voice, outPath);
    if (ttsFileLooksComplete(outPath, text)) return { url: urlPath, durationSec: r.durationSec };
    console.warn('intro synth undersized:', filename);
    return null;
  } catch (e) {
    console.error('intro synth failed:', e.message);
    return null;
  }
}

async function assembleBrief(brief, date) {
  const topicIds = brief.topic_ids || [];
  if (!topicIds.length) return null;
  const requestedVoice = brief.voice || DEFAULT_VOICE;

  // v2.1: NOTHING IS TRIMMED. scale and play_sec are gone. Each topic resolves
  // to a complete pre-rendered file at the user's chosen depth, and the client
  // plays every file to its end. That is the whole fix for mid-sentence cuts:
  // there is no longer any point at which audio is stopped early.
  const q = `SELECT topic_id, voice, tier, cycle_date, audio_path, duration_sec,
                    sources, story_count, status,
                    (SELECT label FROM topics t WHERE t.id = segments.topic_id) AS label
               FROM segments
              WHERE topic_id = ANY($1) AND status = 'ok' AND audio_path <> ''
              ORDER BY cycle_date DESC`;
  const { rows: segs } = await pool.query(q, [topicIds]);

  const voiceRank = v => (v === requestedVoice ? 0 : v === DEFAULT_VOICE ? 1 : 2);

  // Pick one segment per topic. Voice match dominates (a consistent narrator
  // matters more than exact length), then tier. When the requested tier is
  // missing we prefer a SHORTER tier over a longer one -- running under the
  // user's budget is a smaller sin than blowing through it.
  function pickFor(topicId) {
    const cands = segs.filter(x => x.topic_id === topicId);
    if (!cands.length) return null;
    const want = depthOf(brief, topicId);
    const wi = TIER_ORDER.indexOf(want);
    const tierRank = t => {
      const ti = TIER_ORDER.indexOf(t);
      if (ti === wi) return 0;
      return ti < wi ? 1 + (wi - ti) : 10 + (ti - wi);
    };
    return cands.slice().sort((a, b) =>
      voiceRank(a.voice) - voiceRank(b.voice) ||
      tierRank(a.tier) - tierRank(b.tier) ||
      new Date(b.cycle_date) - new Date(a.cycle_date))[0];
  }

  let ordered = topicIds.map(pickFor).filter(Boolean);
  if (!ordered.length) return null;

  // SERVE-TIME BUDGET. config validates on save, but a user whose entitlement
  // SHRINKS (trial expiry on day 8, or a lapsed subscription) never re-saves —
  // and since v2.1 plays every segment whole, nothing would otherwise stop us
  // serving a 10-minute Cast to a 5-minute account forever.
  //
  // Keep topics in the user's own order until the budget is spent, then stop.
  // Dropped topics are REPORTED, not silently swallowed: the client turns
  // over_budget into the upgrade prompt.
  const { rows: urows } = await pool.query('SELECT tier, created_at FROM users WHERE id=$1', [brief.user_id]);
  const owner = urows[0] || { tier: 'free' };
  const entitledSec = maxLenFor(owner) * 60;
  const wantSec = Math.max(1, (brief.length_min || FREE_MAX_LEN)) * 60;
  const effectiveBudgetSec = Math.min(wantSec, entitledSec);

  const dropped = [];
  let spent = 0;
  const kept = [];
  for (const seg of ordered) {
    const d = seg.duration_sec || 0;
    // Always keep the first topic, even if it alone exceeds the budget —
    // an empty Cast is worse than a slightly long one.
    if (kept.length && spent + d > effectiveBudgetSec) { dropped.push(seg.topic_id); continue; }
    kept.push(seg); spent += d;
  }
  const overBudget = dropped.length > 0;
  ordered = kept;

  const voicesServed = [...new Set(ordered.map(x => x.voice))];
  const primaryVoice = ordered[0].voice;
  const anyFallback  = ordered.some(x => x.voice !== requestedVoice);
  const tierFallback = ordered.filter(x => x.tier !== depthOf(brief, x.topic_id));

  let overheadSec = 0;
  const items = [];
  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i];
    let transition;
    if (i > 0) transition = await ensureTransitionAudio(seg.label, seg.voice, date);
    if (transition && transition.durationSec) overheadSec += transition.durationSec;
    items.push({
      topic_id: seg.topic_id,
      label: seg.label,
      tier: seg.tier,
      tier_requested: depthOf(brief, seg.topic_id),
      transition_url: transition && transition.url ? absolute(transition.url) : null,
      url: absolute(seg.audio_path),
      duration_sec: seg.duration_sec,
      sources: seg.sources || [],
      voice: seg.voice,
      status: seg.status,
    });
  }

  const tz = brief.timezone || 'America/New_York';
  const introDate = new Date(date + 'T12:00:00');
  const weekday = introDate.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });

  const { rows: urow } = await pool.query('SELECT name FROM users WHERE id=$1', [brief.user_id]);
  const intro = await ensureIntroAudio(urow[0] || null, primaryVoice, date, tz);
  if (intro && intro.durationSec) overheadSec += intro.durationSec;
  const firstName = urow[0] && urow[0].name ? String(urow[0].name).trim().split(/\s+/)[0] : null;
  const introText = firstName
    ? 'Hey ' + firstName + ', here\'s your Cast. ' + weekday + '.'
    : 'Here\'s your Cast. ' + weekday + '.';

  // TWO totals, deliberately. content_sec is what the depth meter budgets
  // against; total_sec is real playback. Intro and transitions are excluded
  // from the budget by product decision, so total_sec runs slightly longer.
  const contentSec = items.reduce((a, i) => a + (i.duration_sec || 0), 0);
  const budgetSec  = effectiveBudgetSec;
  const missingTopics = topicIds.length - items.length - dropped.length;

  const manifest = {
    date,
    voice: primaryVoice,
    voice_requested: requestedVoice,
    voice_pending: anyFallback
      ? 'Some segments are still in your previous voice — your new voice will be fully in place after tomorrow morning\'s update.'
      : undefined,
    voices_used: voicesServed,
    default_depth: TIERS[brief.default_depth] ? brief.default_depth : DEFAULT_TIER,
    intro: introText,
    intro_url: intro && intro.url ? absolute(intro.url) : undefined,
    items,
    requested_topic_count: topicIds.length,
    included_topic_count: items.length,
    missing_topic_count: missingTopics,
    content_sec: contentSec,
    total_sec: contentSec + overheadSec,
    budget_sec: budgetSec,
    entitled_sec: entitledSec,
    over_budget: overBudget || undefined,
    dropped_topics: dropped.length ? dropped : undefined,
    trial: { active: inTrial(owner), daysRemaining: trialDaysLeft(owner) },
  };

  if (tierFallback.length) {
    manifest.depth_pending = tierFallback.length + ' topic(s) aren\'t at your chosen depth yet — ' +
      'they\'ll be ready after tomorrow morning\'s update.';
  }
  // One note, most actionable first. These were previously separate ifs and the
  // later branch could overwrite the earlier one.
  if (overBudget) {
    manifest.note = dropped.length + ' topic(s) didn\'t fit in your ' +
      Math.floor(budgetSec / 60) + '-minute Cast. Upgrade for longer Casts, or lower a topic\'s depth.';
  } else if (missingTopics > 0) {
    manifest.note = missingTopics + ' of your topics don\'t have audio yet — they\'ll be in tomorrow\'s Cast.';
  } else if (contentSec < budgetSec * 0.8) {
    manifest.note = 'Today\'s news ran short — this is everything that happened.';
  }
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

app.get('/api/catalog', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, label, kind, window_hours FROM topics WHERE kind='category' AND is_live=true ORDER BY label`);
  // Optional auth: anonymous callers get the free budget so the picker can
  // render before registration completes.
  let u = null;
  try { u = await getReqUser(req); } catch (_) { u = null; }
  const paid = u ? isPaid(u) : false;
  res.json({
    categories: rows,
    leagues: SEED.TEAM_LEAGUES,
    cities: SEED.CITIES,
    follows: SEED.FOLLOW_SEEDS,
    // The client MUST read tier costs from here rather than hardcoding them.
    // If a tier is retuned server-side, a hardcoded meter would silently lie
    // and users would go back to overrunning their budget.
    tiers: TIER_ORDER.map(t => TIERS[t]),
    default_depth: DEFAULT_TIER,
    budget: {
      content_sec: (u ? maxLenFor(u) : FREE_MAX_LEN) * 60,
      tier: u ? u.tier : 'free',
      max_categories: paid ? null : FREE_MAX_CATEGORIES,
      max_custom: paid ? PAID_MAX_CUSTOM : 0,
      trial_active: inTrial(u),
      trial_days_remaining: trialDaysLeft(u),
    },
  });
});

app.get('/api/me', requireUser(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [req.user.id]);
  res.json({
    userId: req.user.id,     // pass this to Purchases.logIn() BEFORE any purchase
    id: req.user.id,
    tier: req.user.tier,
    name: req.user.name || null,
    limits: {
      maxLengthMin: maxLenFor(req.user),
      maxCategories: isPaid(req.user) ? null : FREE_MAX_CATEGORIES,
      maxCustom: isPaid(req.user) ? PAID_MAX_CUSTOM : 0,
      contentBudgetSec: maxLenFor(req.user) * 60,
    },
    trial: { active: inTrial(req.user), daysRemaining: trialDaysLeft(req.user) },
    tiers: TIER_ORDER.map(t => TIERS[t]),
    brief: rows[0] || null,
  });
}));

// Set the brief: ordered topics, length, voice, delivery time.
app.put('/api/brief/config', requireUser(async (req, res) => {
  const u = req.user;
  const { topic_ids = [], length_min = FREE_MAX_LEN, voice = DEFAULT_VOICE, deliver_at = null,
          timezone, name, default_depth, topic_depths } = req.body || {};
  if (typeof name === 'string' && name.trim().length && name.trim().length <= 40) {
    await pool.query('UPDATE users SET name=$2 WHERE id=$1', [u.id, name.trim()]);
  }
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

  // ---- DEPTH + BUDGET -------------------------------------------------------
  // Sanitize: unknown tier ids are ignored rather than rejected, so an older
  // app build can't lock a user out of saving.
  const defDepth = TIERS[default_depth] ? default_depth : DEFAULT_TIER;
  const depths = {};
  if (topic_depths && typeof topic_depths === 'object' && !Array.isArray(topic_depths)) {
    for (const [k, v] of Object.entries(topic_depths)) {
      if (ordered.includes(k) && TIERS[v] && v !== defDepth) depths[k] = v;
    }
  }
  // Server-side budget enforcement. The client meter should prevent this, but a
  // stale build must not be able to oversubscribe -- and this same response is
  // what a user hits on day 8 when their trial ends and their saved config no
  // longer fits.
  const contentSec = ordered.reduce((a, id) => a + TIERS[depths[id] || defDepth].cost_sec, 0);
  const budgetSec = Math.min(len, maxLenFor(u)) * 60;
  if (contentSec > budgetSec) {
    return res.status(403).json({
      error: 'budget_exceeded',
      content_sec: contentSec,
      budget_sec: budgetSec,
      over_by_sec: contentSec - budgetSec,
      requiredTier: isPaid(u) ? undefined : 'paid',
      message: 'That selection needs ' + Math.ceil(contentSec / 60) + ' minutes of content but your Cast is ' +
               Math.floor(budgetSec / 60) + ' minutes. Remove a topic or lower a depth.',
    });
  }

  const { rows: prev } = await pool.query('SELECT topic_id FROM topic_subscriptions WHERE user_id=$1', [u.id]);
  for (const p of prev) if (!ordered.includes(p.topic_id)) await unsubscribeTopic(u.id, p.topic_id);
  for (const id of ordered) await subscribeTopic(u.id, id);

  await pool.query(
    `INSERT INTO user_briefs (user_id, topic_ids, length_min, voice, deliver_at, timezone,
                              default_depth, topic_depths, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (user_id) DO UPDATE SET
       topic_ids=$2, length_min=$3, voice=$4, deliver_at=$5,
       timezone=COALESCE($6, user_briefs.timezone),
       default_depth=$7, topic_depths=$8, updated_at=now()`,
    [u.id, JSON.stringify(ordered), len, voice, deliver_at, timezone || null,
     defDepth, JSON.stringify(depths)]);

  // Assemble immediately from the existing catalog so they hear it now.
  const { rows: b } = await pool.query('SELECT * FROM user_briefs WHERE user_id=$1', [u.id]);
  const manifest = await assembleBrief(b[0], cycleDate());
  res.json({ ok: true, topics: ordered, length_min: len, voice,
             default_depth: defDepth, topic_depths: depths,
             content_sec: contentSec, budget_sec: budgetSec, manifest });
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
// Wipe today's catalog and regenerate everything fresh under the current prompt.
// Useful when the prompt or seed has changed and you don't want to wait for 3am.
app.post('/api/admin/batch/wipe-and-run', requireAdmin(async (_req, res) => {
  res.json({ ok: true, wiping: true });
  (async () => {
    try {
      const date = cycleDate();
      console.log('=== WIPE + REBUILD initiated for ' + date + ' ===');
      // Delete rendered audio for today so it can't be served stale.
      await pool.query('DELETE FROM segments WHERE cycle_date=$1', [date]);
      // Also flush intros and transitions so they get regenerated fresh.
      const introsDir = path.join(AUDIO_DIR, '_intros', date);
      const transitionsDir = path.join(AUDIO_DIR, '_transitions', date);
      if (fs.existsSync(introsDir)) fs.rmSync(introsDir, { recursive: true, force: true });
      if (fs.existsSync(transitionsDir)) fs.rmSync(transitionsDir, { recursive: true, force: true });
      // Delete on-disk audio for today.
      for (const t of fs.readdirSync(AUDIO_DIR)) {
        if (t === '_intros' || t === '_transitions') continue;
        const p = path.join(AUDIO_DIR, t, date);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      }
      console.log('wipe complete, running batch...');
      await runBatch();
    } catch (e) { console.error('wipe-and-run error:', e); }
  })();
}));

app.post('/api/admin/batch/run', requireAdmin(async (_req, res) => {
  res.json({ ok: true, started: true });   // respond immediately; batch runs on
  runBatch().catch(e => console.error('batch error:', e));  // the server, not the request
}));

// The health metric that would have caught the Dodgers bug on night one.
app.get('/api/admin/catalog/health', requireAdmin(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (s.topic_id) s.topic_id, t.label, t.kind, t.window_hours,
            s.story_count, s.status, s.cycle_date, t.subscriber_count,
            (SELECT COUNT(DISTINCT s2.tier)::int FROM segments s2
              WHERE s2.topic_id = s.topic_id AND s2.cycle_date = s.cycle_date
                AND s2.status = 'ok' AND s2.audio_path <> '') AS tiers_ready
       FROM segments s JOIN topics t ON t.id=s.topic_id
      ORDER BY s.topic_id, s.cycle_date DESC`);
  const thin = rows.filter(r => r.status !== 'ok');
  res.json({
    cycle: cycleDate(),
    total: rows.length,
    ok: rows.filter(r => r.status === 'ok').length,
    thin: rows.filter(r => r.status === 'thin').length,
    // A topic with fewer than 3 tiers ready will silently fall back to a
    // different depth than the user asked for, so surface it here.
    incomplete_tiers: rows.filter(r => (r.tiers_ready || 0) < TIER_ORDER.length)
      .map(r => ({ topic_id: r.topic_id, tiers_ready: r.tiers_ready || 0 })),
    failed: rows.filter(r => r.status === 'failed').length,
    needs_attention: thin,
    topics: rows.sort((a, b) => a.story_count - b.story_count),
  });
}));

// Testing affordance. DEVELOPER_IDS pins the developer account to 'paid', so
// the trial and the day-8 downgrade can only be exercised on a separate
// account -- and without this, each test would mean waiting a real week.
app.post('/api/admin/trial/reset', requireAdmin(async (req, res) => {
  const { userId, daysAgo = 0 } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId_required' });
  const { rows } = await pool.query(
    `UPDATE users SET created_at = now() - ($2 || ' days')::interval
      WHERE id=$1 RETURNING id, tier, created_at`, [userId, String(Number(daysAgo) || 0)]);
  if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
  const u = rows[0];
  res.json({ ok: true, user: u, trial_active: inTrial(u), trial_days_remaining: trialDaysLeft(u),
             maxLengthMin: maxLenFor(u), note: DEVELOPER_IDS.includes(u.id)
               ? 'WARNING: this id is in DEVELOPER_IDS and is forced to paid — use a different account to test the trial.'
               : undefined });
}));

app.get('/api/admin/topics', requireAdmin(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, kind, label, norm_key, window_hours, subscriber_count, is_live FROM topics ORDER BY kind, label');
  res.json({ count: rows.length, topics: rows });
}));

// Audition a voice on a REAL segment without running a full batch.
// GET /api/admin/voice-sample?topic=world_news&voice=onyx
// TEMP DIAGNOSTIC — open in a browser to see exactly what's wrong for one user.
// Usage: /api/admin/diag/user?token=ADMINTOKEN&user=usr_b4ce3c8a68d8
app.get('/api/admin/diag/user', async (req, res) => {
  const t = String(req.query.token || '');
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  const userId = String(req.query.user || '');
  if (!userId) return res.status(400).json({ error: 'user required' });
  const result = { userId };
  try {
    const u = await pool.query('SELECT id,tier,created_at FROM users WHERE id=$1', [userId]);
    result.user = u.rows[0] || null;
    const b = await pool.query('SELECT user_id,voice,length_min,topic_ids,timezone,deliver_at,updated_at FROM user_briefs WHERE user_id=$1', [userId]);
    result.brief = b.rows[0] || null;
    if (b.rows[0]) {
      const tids = b.rows[0].topic_ids || [];
      result.topic_count = tids.length;
      const seg = await pool.query(
        `SELECT topic_id, voice, tier, cycle_date::text as cycle_date, duration_sec, status
           FROM segments
          WHERE topic_id = ANY($1) AND status='ok'
          ORDER BY topic_id, cycle_date DESC`, [tids]);
      const perTopic = {};
      for (const s of seg.rows) {
        if (!perTopic[s.topic_id]) perTopic[s.topic_id] = [];
        if (perTopic[s.topic_id].length < 3) perTopic[s.topic_id].push({voice:s.voice,cycle_date:s.cycle_date,duration_sec:s.duration_sec});
      }
      result.segments_per_topic = perTopic;
      result.topics_with_no_segments = tids.filter(id => !perTopic[id]);
      // simulate what assembleBrief would return right now
      try {
        const m = await assembleBrief(b.rows[0], cycleDate());
        result.assembled = m ? {
          items: m.items.length, content_sec: m.content_sec, total_sec: m.total_sec,
          budget_sec: m.budget_sec, voice: m.voice,
          tiers: m.items.map(i => i.topic_id + ':' + i.tier + (i.tier !== i.tier_requested ? '(wanted ' + i.tier_requested + ')' : '')),
          note: m.note, depth_pending: m.depth_pending } : null;
      } catch (e) { result.assembled_error = e.message; }
    }
  } catch (e) { result.error = e.message; }
  res.json(result);
});

app.get('/api/admin/voice-sample', requireAdmin(async (req, res) => {
  const topicId = req.query.topic || 'world_news';
  const voice = req.query.voice || DEFAULT_VOICE;
  if (!VOICES[voice]) return res.status(400).json({ error: 'bad_voice', available: Object.keys(VOICES) });
  const { rows } = await pool.query(
    `SELECT script, cycle_date FROM segments WHERE topic_id=$1 AND status<>'failed' AND tier='headlines'
     ORDER BY cycle_date DESC LIMIT 1`, [topicId]);
  if (!rows[0]) return res.status(404).json({ error: 'no_segment_for_topic', topic: topicId });
  const date = new Date(rows[0].cycle_date).toISOString().slice(0, 10);
  const dir = path.join(AUDIO_DIR, topicId, date);
  fs.mkdirSync(dir, { recursive: true });
  // Content-address the audition file too, and write it into the HEADLINES tier
  // so it satisfies the (topic_id, cycle_date, voice, tier) unique index. The
  // old ON CONFLICT named a constraint that v2.1 drops, which would have thrown.
  const sampleHash = crypto.createHash('sha1').update(rows[0].script + '|' + voice).digest('hex').slice(0, 6);
  const out = path.join(dir, voice + '.' + sampleHash + '.mp3');
  const { durationSec } = await synthesizeToFile(rows[0].script, voice, out);
  const url = '/audio/' + topicId + '/' + date + '/' + voice + '.' + sampleHash + '.mp3';
  await pool.query(
    `INSERT INTO segments (topic_id, cycle_date, voice, tier, audio_path, duration_sec,
                           script, sources, story_count, status)
     SELECT topic_id, cycle_date, $3, 'headlines', $4, $5, script, sources, story_count, status
       FROM segments WHERE topic_id=$1 AND cycle_date=$2 AND tier='headlines' LIMIT 1
     ON CONFLICT (topic_id, cycle_date, voice, tier)
       DO UPDATE SET audio_path=$4, duration_sec=$5`,
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
