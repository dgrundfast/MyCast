/* =========================================================================
   MyCast Backend — v9
   Two modes: GET BRIEFED (stay informed) + DEEP DIVE (build knowledge)
   - Fast start: episodes are generated as SEGMENTS, synthesized one at a
     time, and served by URL. The player polls a manifest and plays each
     segment the moment it's ready — so audio starts in seconds while the
     rest loads behind the scenes.
   - Real sources: Briefs retrieve real, recent articles (keyless Google
     News RSS) and filter them to the chosen time window, then write the
     script grounded in them. Sources are stored and returned.
   - MOCK_MODE: if API keys are missing, the whole pipeline runs with
     placeholders so the architecture can be tested without keys.

   Env vars (set in Railway → Variables):
     ANTHROPIC_API_KEY   (required for real scripts)
     ELEVENLABS_API_KEY  (required for real audio)
     PORT                (Railway injects this)
     PUBLIC_BASE_URL     (optional; e.g. https://mycast-v0fx-production.up.railway.app)
   ========================================================================= */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));

const AK = process.env.ANTHROPIC_API_KEY || '';
const EK = process.env.ELEVENLABS_API_KEY || '';
const MOCK_MODE = !AK || !EK; // no keys -> safe placeholder mode for testing
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // optional absolute URLs

const rss = new Parser({ timeout: 8000 });

/* ---------- audio storage (disk; served by URL) -------------------------
   Railway's filesystem is ephemeral (wiped on redeploy/restart). That's
   fine for "listen now" — for durable Library across deploys, swap this
   for S3 / Cloudflare R2 later (see PRODUCTION NOTES at bottom).          */
// Set AUDIO_DIR to a Railway Volume mount (e.g. /data/audio) so segment audio
// survives redeploys. Falls back to local disk (ephemeral) if unset.
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio_cache');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));

/* ---------- voices ------------------------------------------------------ */
const VOICES = {
  // FREE — keep these two genuinely good; they're the hook.
  josh:  { id: 'TxGEqnHWrfWFTfGW9XjX', displayName: 'Josh',  gender: 'male',   tier: 'free' },
  bella: { id: 'EXAVITQu4vr4xnSDxMaL', displayName: 'Bella', gender: 'female', tier: 'free' },
  // PAID — expand as you license more.
  adam:  { id: 'pNInz6obpgDQGcFmaJgB', displayName: 'Adam',  gender: 'male',   tier: 'plus' },
  rachel:{ id: '21m00Tcm4TlvDq8ikWAM', displayName: 'Rachel',gender: 'female', tier: 'plus' },
  arnold:{ id: 'VR6AewLTigWG4xSOukaG', displayName: 'Arnold',gender: 'male',   tier: 'pro'  },
};
function resolveVoice(voiceId) { return VOICES[voiceId] || VOICES.josh; }

/* =========================================================================
   STORAGE — durable when DATABASE_URL is set, in-memory otherwise.
   Strategy: a hot in-memory cache (so in-progress generation mutates a live
   object) PLUS Postgres persistence (so data survives redeploys/restarts and
   the Library rehydrates after a restart). If there's no DATABASE_URL, it
   behaves exactly like the old in-memory MVP — nothing breaks before you add
   Postgres; it auto-activates the moment DATABASE_URL exists.
   ========================================================================= */
const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_DB = !!DATABASE_URL;
const pool = USE_DB
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const id = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

// hot cache (also the entire store when USE_DB is false)
const _episodes = new Map();
const _series = new Map();
const _schedules = new Map();
const _library = []; // newest-first { type, id, title, createdAt } (in-memory mode)

async function initDb() {
  if (!USE_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, token text UNIQUE, tier text DEFAULT 'free',
      gen_count int DEFAULT 0, period_start text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id text PRIMARY KEY, mode text, user_id text, data jsonb NOT NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS series (
      id text PRIMARY KEY, user_id text, data jsonb NOT NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id text PRIMARY KEY, user_id text, data jsonb NOT NULL,
      created_at timestamptz DEFAULT now()
    );
  `);
  // safe column adds for pre-existing tables
  for (const t of ['episodes', 'series', 'schedules']) {
    try { await pool.query('ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS user_id text'); } catch (e) {}
  }
  console.log('Postgres ready.');
}

const _users = new Map();        // userId -> user
const _tokenIndex = new Map();    // token -> userId

const store = {
  async saveEpisode(ep) {
    _episodes.set(ep.id, ep);
    if (USE_DB) await pool.query(
      `INSERT INTO episodes (id, mode, user_id, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, mode = EXCLUDED.mode, user_id = EXCLUDED.user_id`,
      [ep.id, ep.mode, ep.userId || null, ep]);
  },
  async updateEpisode(ep) { return store.saveEpisode(ep); },
  async getEpisode(epId) {
    if (_episodes.has(epId)) return _episodes.get(epId);
    if (USE_DB) {
      const r = await pool.query('SELECT data FROM episodes WHERE id=$1', [epId]);
      if (r.rows[0]) { _episodes.set(epId, r.rows[0].data); return r.rows[0].data; }
    }
    return null;
  },
  async saveSeries(s) {
    _series.set(s.id, s);
    if (USE_DB) await pool.query(
      `INSERT INTO series (id, user_id, data) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, user_id = EXCLUDED.user_id`,
      [s.id, s.userId || null, s]);
  },
  async updateSeries(s) { return store.saveSeries(s); },
  async getSeries(sId) {
    if (_series.has(sId)) return _series.get(sId);
    if (USE_DB) {
      const r = await pool.query('SELECT data FROM series WHERE id=$1', [sId]);
      if (r.rows[0]) { _series.set(sId, r.rows[0].data); return r.rows[0].data; }
    }
    return null;
  },
  // Evergreen reuse: find a fully-successful series with this signature (any
  // owner) to clone, so identical deep dives never re-bill the LLM or TTS.
  async findSharedSeries(sig) {
    for (const s of _series.values()) {
      if (s.sig === sig && s.reusable === true) return s;
    }
    if (USE_DB) {
      const r = await pool.query(
        "SELECT data FROM series WHERE data->>'sig'=$1 AND data->>'reusable'='true' ORDER BY created_at ASC LIMIT 1", [sig]);
      if (r.rows[0]) return r.rows[0].data;
    }
    return null;
  },
  async saveSchedule(sc) {
    _schedules.set(sc.id, sc);
    if (USE_DB) await pool.query(
      `INSERT INTO schedules (id, user_id, data) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, user_id = EXCLUDED.user_id`,
      [sc.id, sc.userId || null, sc]);
  },
  async listSchedules(userId) {
    if (USE_DB) {
      const r = await pool.query('SELECT data FROM schedules WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
      return r.rows.map(x => x.data);
    }
    return [..._schedules.values()].filter(s => s.userId === userId);
  },
  async listAllSchedules() {
    if (USE_DB) {
      const r = await pool.query('SELECT data FROM schedules');
      return r.rows.map(x => x.data);
    }
    return [..._schedules.values()];
  },
  async deleteSchedule(scheduleId, userId) {
    const cached = _schedules.get(scheduleId);
    if (USE_DB) {
      const r = await pool.query('DELETE FROM schedules WHERE id=$1 AND user_id=$2', [scheduleId, userId]);
      _schedules.delete(scheduleId);
      return r.rowCount > 0;
    }
    if (cached && cached.userId === userId) { _schedules.delete(scheduleId); return true; }
    return false;
  },
  async addToLibrary(item) {
    if (!USE_DB) _library.unshift(item); // DB mode derives library from tables
  },
  async getLibrary(userId) {
    if (USE_DB) {
      const r = await pool.query(`
        SELECT 'brief' AS type, id, data->>'title' AS title, created_at
          FROM episodes WHERE mode = 'brief' AND user_id = $1
        UNION ALL
        SELECT 'deepdive' AS type, id, data->>'topic' AS title, created_at
          FROM series WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 200`, [userId]);
      return r.rows.map(x => ({ type: x.type, id: x.id, title: x.title, createdAt: x.created_at }));
    }
    return _library.filter(i => i.userId === userId);
  },

  /* ---- users / accounts ---- */
  async createUser(u) {
    _users.set(u.id, u); if (u.token) _tokenIndex.set(u.token, u.id);
    if (USE_DB) await pool.query(
      `INSERT INTO users (id, token, tier, gen_count, period_start) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET token=EXCLUDED.token, tier=EXCLUDED.tier,
         gen_count=EXCLUDED.gen_count, period_start=EXCLUDED.period_start`,
      [u.id, u.token, u.tier, u.gen_count, u.period_start]);
    return u;
  },
  async updateUser(u) { return store.createUser(u); },
  async getUser(uId) {
    if (_users.has(uId)) return _users.get(uId);
    if (USE_DB) {
      const r = await pool.query('SELECT * FROM users WHERE id=$1', [uId]);
      if (r.rows[0]) { _users.set(uId, r.rows[0]); if (r.rows[0].token) _tokenIndex.set(r.rows[0].token, uId); return r.rows[0]; }
    }
    return null;
  },
  async getUserByToken(token) {
    if (_tokenIndex.has(token)) return _users.get(_tokenIndex.get(token));
    if (USE_DB) {
      const r = await pool.query('SELECT * FROM users WHERE token=$1', [token]);
      if (r.rows[0]) { _users.set(r.rows[0].id, r.rows[0]); _tokenIndex.set(token, r.rows[0].id); return r.rows[0]; }
    }
    return null;
  },
};

/* ---------- time windows ------------------------------------------------ */
const WINDOW_HOURS = { '12h': 12, '24h': 24, '48h': 48, '72h': 72, '1w': 168 };

/* ---------- deep dive depth -> episode count ---------------------------- */
const DEPTH = {
  enough_to_be_dangerous: { episodes: 1, label: 'Enough to be dangerous' },
  conversational:         { episodes: 3, label: 'Conversational' },
  well_versed:            { episodes: 5, label: 'Well-versed' },
  black_belt:             { episodes: 7, label: 'Black Belt' },
};

/* =========================================================================
   ACCOUNTS & TIERS
   - Each request resolves to a user via "Authorization: Bearer <token>".
   - If no/invalid token, it falls back to a shared "anon" free account, so
     the app keeps working during integration. Anon is still subject to the
     free limit, so there's no "no-token = unlimited" loophole.
   - Monthly generation limits enforced per tier; voices and Pro features
     gated per tier. Tier is set by billing later via /api/admin/set-tier.
   Tunable via env: FREE_LIMIT (5), PLUS_LIMIT (30), BLACK_BELT_MIN_TIER (free),
   ADMIN_TOKEN (for setting tiers).
   ========================================================================= */
const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '5', 10);
const PLUS_LIMIT = parseInt(process.env.PLUS_LIMIT || '30', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Developer accounts — always Pro, never hit usage limits
const DEVELOPER_IDS = (process.env.DEVELOPER_IDS || 'usr_13f0d135e6c2').split(',').map(s => s.trim()).filter(Boolean);
const TIER_RANK = { free: 0, plus: 1, pro: 2 };

// ⚠️ PRODUCT DECISIONS (flip these freely):
const DEEPDIVE_COUNTS_AS = 1;                 // a Deep Dive series counts as N generations (default 1)
const BLACK_BELT_MIN_TIER = process.env.BLACK_BELT_MIN_TIER || 'free'; // 'free' = open to all

function limitFor(tier) { return tier === 'pro' ? Infinity : (tier === 'plus' ? PLUS_LIMIT : FREE_LIMIT); }

/* Billing: RevenueCat webhook config. Set REVENUECAT_WEBHOOK_TOKEN in Railway
   to the same Authorization value you put in RevenueCat's webhook settings.
   Edit REVENUECAT_TIER_MAP to match the entitlement/product IDs you configure
   in RevenueCat; the heuristic fallback catches anything containing pro/plus. */
const REVENUECAT_WEBHOOK_TOKEN = process.env.REVENUECAT_WEBHOOK_TOKEN || '';
const REVENUECAT_TIER_MAP = {
  // 'mycast_pro': 'pro', 'mycast_plus_monthly': 'plus',  // <- your real RC identifiers
};
function tierFromRevenueCat(ev) {
  const ids = [].concat(ev.entitlement_ids || [], ev.product_id ? [ev.product_id] : []).map(x => String(x).toLowerCase());
  for (const id of ids) if (REVENUECAT_TIER_MAP[id]) return REVENUECAT_TIER_MAP[id];
  if (ids.some(id => id.includes('pro'))) return 'pro';
  if (ids.some(id => id.includes('plus'))) return 'plus';
  return 'plus'; // an unclassifiable active purchase still grants the entry paid tier
}
async function setUserTier(userId, tier) {
  const user = await store.getUser(userId);
  if (!user) return false;
  user.tier = tier;
  await store.updateUser(user);
  return true;
}

function periodKey() { const d = new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1); }
function ensurePeriod(user) {
  const k = periodKey();
  if (user.period_start !== k) { user.period_start = k; user.gen_count = 0; }
}
function voiceAllowed(user, voiceId) {
  const v = VOICES[voiceId] || VOICES.josh;
  return TIER_RANK[user.tier] >= TIER_RANK[v.tier];
}

// Resolve the user for a request (token -> user, else shared anon account).
async function getReqUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const u = await store.getUserByToken(m[1].trim());
    if (u) {
      // Developer accounts always get Pro tier and unlimited generations
      if (DEVELOPER_IDS.includes(u.id)) {
        u.tier = 'pro';
        u.gen_count = 0;
      }
      return u;
    }
  }
  let anon = await store.getUser('anon');
  if (!anon) anon = await store.createUser({ id: 'anon', token: 'anon', tier: 'free', gen_count: 0, period_start: periodKey() });
  // Always reset anon count so unauthenticated requests (dev testing) never hit a wall
  anon.gen_count = 0;
  anon.tier = 'plus'; // Give anon a higher limit for testing
  return anon;
}

// Reserve a generation against the user's monthly limit. Returns false if over.
async function reserveGeneration(user, count) {
  ensurePeriod(user);
  const lim = limitFor(user.tier);
  if (user.gen_count + count > lim) return false;
  user.gen_count += count;
  await store.updateUser(user);
  return true;
}

/* =========================================================================
   RETRIEVAL — real, recent, time-windowed sources (topic-routed)
   Providers, by topic:
     - General topics : Google News RSS (keyless) + Currents (if key set)
     - Finance topics : Marketaux (if key set) + Google News RSS
   Design rules:
     - Google News RSS is the always-on backbone (keyless), so retrieval
       never hard-fails even if the keyed providers are missing or down.
     - Any provider that lacks a key or errors is skipped silently ([]).
     - Results are deduped across providers and filtered to the time window.
     - Per-(topic,window) results are cached briefly to respect rate limits
       (the right pattern for a paid app: cache + schedule, not per-request).
   Optional env vars: CURRENTS_API_KEY, MARKETAUX_API_KEY
   ========================================================================= */
const CURRENTS_API_KEY  = process.env.CURRENTS_API_KEY  || '';
const MARKETAUX_API_KEY = process.env.MARKETAUX_API_KEY || '';

// Best-effort finance detector. Misses only cost a finance topic its
// finance-specific provider — Google News still covers it — so we keep this
// conservative to avoid injecting finance noise into non-finance topics.
const FINANCE_KEYWORDS = [
  'stock', 'stocks', 'share price', 'stock market', 'markets', 'finance', 'financial',
  'earnings', 'ipo', 'nasdaq', 'dow jones', 's&p 500', 'sp500', 'nyse', 'bonds',
  'treasury yield', 'federal reserve', 'interest rate', 'rate hike', 'rate cut',
  'inflation', 'crypto', 'bitcoin', 'ethereum', 'etf', 'dividend', 'hedge fund',
  'wall street', 'forex', 'commodities', 'oil price', 'merger', 'acquisition', 'valuation',
];
function isFinanceTopic(topic) {
  const t = String(topic).toLowerCase();
  return FINANCE_KEYWORDS.some(k => t.includes(k));
}

/* Curated preset channels: each tile maps to a tuned set of queries (and
   provider hints) so a broad interest like "Markets & Finance" produces a
   clean, reliable briefing instead of whatever a vague typed topic returns. */
const CHANNELS = {
  world_news:      { label: 'World News',            queries: ['world news', 'international news today'] },
  us_politics:     { label: 'US Politics',           queries: ['US politics', 'Congress', 'White House'] },
  technology:      { label: 'Technology',            queries: ['technology news', 'artificial intelligence', 'tech industry'] },
  markets_finance: { label: 'Markets & Finance',     queries: ['stock market today', 'Federal Reserve', 'S&P 500 earnings'], finance: true },
  science:         { label: 'Science',               queries: ['science research', 'scientific discovery'] },
  health:          { label: 'Health',                queries: ['health news', 'medical research'] },
  sports:          { label: 'Sports',                queries: ['sports news today'] },
  entertainment:   { label: 'Entertainment',         queries: ['entertainment news', 'movies music news'] },
  climate:         { label: 'Climate & Environment', queries: ['climate change news', 'environment news'] },
  business:        { label: 'Business',              queries: ['business news', 'economy news'] },
};

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
}
function dedupeSources(items) {
  const seen = new Set();
  const out = [];
  for (const s of items) {
    const tkey = normTitle(s.title);                 // collapses the same wire story across many outlets
    const ukey = (s.url || '').toLowerCase().split('?')[0];
    const key = tkey || ukey;
    if (!key || seen.has(key) || (ukey && seen.has('u:' + ukey))) continue;
    seen.add(key);
    if (ukey) seen.add('u:' + ukey);
    out.push(s);
  }
  return out;
}

// short cache so we don't hit news APIs on every single request
const retrievalCache = new Map(); // "topic|window" -> { at, data }

/* ---- Rundown combo popularity tracking + 12h pre-generation cache -------- */
const comboPopularity = new Map(); // "channelIds|lengthMin" -> request count
const popularComboCache = new Map(); // "channelIds|lengthMin" -> { at, episode }
const POPULAR_CACHE_TTL_MS = 6 * 3600 * 1000; // 6 hours — keeps cached news fresh

function comboKey(channels, lengthMin) {
  return (channels || []).slice().sort().join(',') + '|' + lengthMin;
}

function trackComboPopularity(channels, topics, lengthMin) {
  // Only track shared, topic-free combos — personalized requests (with custom
  // topics) are unique per user and not worth pre-caching.
  if (topics && topics.length) return;
  if (!channels || !channels.length) return;
  const key = comboKey(channels, lengthMin);
  comboPopularity.set(key, (comboPopularity.get(key) || 0) + 1);
}

function getPopularCombos(limit) {
  return Array.from(comboPopularity.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 15)
    .map(([key, count]) => {
      const [chanStr, lengthStr] = key.split('|');
      return { channels: chanStr.split(',').filter(Boolean), lengthMin: parseInt(lengthStr, 10), count };
    });
}

function getCachedPopularEpisode(channels, lengthMin) {
  const key = comboKey(channels, lengthMin);
  const cached = popularComboCache.get(key);
  if (cached && Date.now() - cached.at < POPULAR_CACHE_TTL_MS) return cached.episode;
  return null;
}
const RETRIEVAL_TTL_MS = 15 * 60 * 1000;

/* ---- providers (each returns [] on any failure; never throws) ---------- */
async function fromGoogleNews(topic, cutoff) {
  try {
    const feed = await rss.parseURL(
      'https://news.google.com/rss/search?q=' + encodeURIComponent(topic) + '&hl=en-US&gl=US&ceid=US:en'
    );
    const out = [];
    // Use a fallback cutoff of 7 days if the strict window returns nothing
    const fallbackCutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const item of feed.items || []) {
      const ts = item.isoDate ? Date.parse(item.isoDate) : (item.pubDate ? Date.parse(item.pubDate) : NaN);
      // Accept article if within strict window OR within 7-day fallback
      if (isNaN(ts)) continue;
      if (ts < fallbackCutoff) continue; // older than 7 days, skip entirely
      const parts = (item.title || '').split(' - '); // "Headline - Publisher"
      const publisher = parts.length > 1 ? parts.pop() : (item.creator || 'News');
      out.push({
        topic, publisher, title: parts.join(' - ') || item.title, url: item.link,
        publishedAt: new Date(ts).toISOString(),
        snippet: (item.contentSnippet || '').slice(0, 280), provider: 'google_news',
        withinWindow: ts >= cutoff, // flag for sorting — recent items lead
      });
    }
    // Sort: articles within the strict window first, then fallback articles
    out.sort((a, b) => {
      if (a.withinWindow && !b.withinWindow) return -1;
      if (!a.withinWindow && b.withinWindow) return 1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
    return out;
  } catch (e) { console.log('google_news error:', e.message); return []; }
}

async function fromCurrents(topic, cutoff) {
  if (!CURRENTS_API_KEY) return [];
  try {
    const url = 'https://api.currentsapi.services/v1/search?language=en&keywords='
      + encodeURIComponent(topic) + '&start_date=' + encodeURIComponent(new Date(cutoff).toISOString())
      + '&apiKey=' + CURRENTS_API_KEY;
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.news || []).map(n => ({
      topic, publisher: hostnameOf(n.url) || n.author || 'Currents',
      title: n.title, url: n.url,
      publishedAt: n.published ? new Date(n.published).toISOString() : null,
      snippet: (n.description || '').slice(0, 280), provider: 'currents',
    })).filter(x => x.publishedAt && Date.parse(x.publishedAt) >= cutoff);
  } catch (e) { console.log('currents error:', e.message); return []; }
}

async function fromMarketaux(topic, cutoff) {
  if (!MARKETAUX_API_KEY) return [];
  try {
    const after = new Date(cutoff).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
    const url = 'https://api.marketaux.com/v1/news/all?language=en&search='
      + encodeURIComponent(topic) + '&published_after=' + encodeURIComponent(after)
      + '&api_token=' + MARKETAUX_API_KEY;
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data || []).map(n => ({
      topic, publisher: n.source || hostnameOf(n.url) || 'Marketaux',
      title: n.title, url: n.url,
      publishedAt: n.published_at ? new Date(n.published_at).toISOString() : null,
      snippet: (n.snippet || n.description || '').slice(0, 280), provider: 'marketaux',
    })).filter(x => x.publishedAt && Date.parse(x.publishedAt) >= cutoff);
  } catch (e) { console.log('marketaux error:', e.message); return []; }
}

/* =========================================================================
   SPORTS DATA — exact scores/schedule for sports topics.
   Detect a team in the topic, then pull its most recent result + next game
   and hand the writer the hard facts (final score, opponent, date) as a
   top-priority source — instead of vague news snippets.
   Keyless and fully graceful: any miss/failure -> normal news retrieval.
   Disable with SPORTS_API_DISABLED=1.
   NOTE: ESPN's endpoints are unofficial. For production terms, swap the two
   fetches below to a keyed provider (API-Sports, balldontlie, etc.).
   ========================================================================= */
const SPORTS_DISABLED = process.env.SPORTS_API_DISABLED === '1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const SPORTS_LEAGUES = [
  { key: 'mlb', sport: 'baseball',   league: 'mlb' },
  { key: 'nba', sport: 'basketball', league: 'nba' },
  { key: 'nfl', sport: 'football',   league: 'nfl' },
  { key: 'nhl', sport: 'hockey',     league: 'nhl' },
  { key: 'epl', sport: 'soccer',     league: 'eng.1' },
];
const teamIndexCache = new Map(); // league.key -> { at, teams:[{id,name,aliases}] }
const TEAM_TTL = 24 * 3600 * 1000;

async function loadLeagueTeams(lg) {
  const c = teamIndexCache.get(lg.key);
  if (c && Date.now() - c.at < TEAM_TTL) return c.teams;
  if (MOCK_MODE) {
    const teams = lg.key === 'mlb'
      ? [{ id: '19', name: 'Los Angeles Dodgers', aliases: ['los angeles dodgers', 'dodgers'] }]
      : [];
    teamIndexCache.set(lg.key, { at: Date.now(), teams });
    return teams;
  }
  try {
    const r = await fetchWithRetry(ESPN + '/' + lg.sport + '/' + lg.league + '/teams', {}, { tries: 2, timeoutMs: 8000 });
    const d = await r.json();
    const raw = (((d.sports || [])[0] || {}).leagues || [])[0] || {};
    const teams = (raw.teams || []).map(x => x.team).filter(Boolean).map(t => {
      const aliases = new Set();
      [t.displayName, t.shortDisplayName, t.name, t.nickname, t.location].forEach(a => { if (a) aliases.add(String(a).toLowerCase()); });
      if (t.location && t.name) aliases.add((t.location + ' ' + t.name).toLowerCase());
      return { id: t.id, name: t.displayName || t.name, aliases: [...aliases] };
    });
    teamIndexCache.set(lg.key, { at: Date.now(), teams });
    return teams;
  } catch (e) { console.log('espn teams error [' + lg.key + ']:', e.message); return []; }
}

async function detectSportsTeam(topic) {
  if (SPORTS_DISABLED) return null;
  const tl = ' ' + String(topic).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  let best = null;
  for (const lg of SPORTS_LEAGUES) {
    const teams = await loadLeagueTeams(lg);
    for (const t of teams) {
      for (const a of t.aliases) {
        if (a.length < 5) continue;                 // skip noisy short nicknames/abbr
        if (tl.includes(' ' + a + ' ') && (!best || a.length > best.len)) best = { lg, team: t, len: a.length };
      }
    }
  }
  return best;
}

async function fetchTeamSchedule(lg, teamId) {
  if (MOCK_MODE) {
    return { last: 'San Francisco Giants 3 @ Los Angeles Dodgers 5 (Final)', lastDate: '2026-06-25',
             next: 'San Diego Padres @ Los Angeles Dodgers', nextDate: '2026-06-28' };
  }
  try {
    const r = await fetchWithRetry(ESPN + '/' + lg.sport + '/' + lg.league + '/teams/' + teamId + '/schedule', {}, { tries: 2, timeoutMs: 8000 });
    const d = await r.json();
    const nowMs = Date.now();
    let last = null, next = null;
    for (const ev of (d.events || [])) {
      const comp = (ev.competitions || [])[0]; if (!comp) continue;
      const cs = comp.competitors || [];
      const home = cs.find(c => c.homeAway === 'home') || cs[0];
      const away = cs.find(c => c.homeAway === 'away') || cs[1];
      if (!home || !away) continue;
      const completed = (((comp.status || ev.status || {}).type) || {}).completed;
      const ms = Date.parse(ev.date);
      const sc = c => (c.score && (c.score.displayValue || c.score.value)) != null ? ' ' + (c.score.displayValue || c.score.value) : '';
      if (completed) {
        const text = away.team.displayName + sc(away) + ' @ ' + home.team.displayName + sc(home) + ' (Final)';
        if (!last || ms > last.ms) last = { ms, text, date: ev.date };
      } else if (ms >= nowMs - 6 * 3600 * 1000) {
        const text = away.team.displayName + ' @ ' + home.team.displayName;
        if (!next || ms < next.ms) next = { ms, text, date: ev.date };
      }
    }
    return { last: last && last.text, lastDate: last && last.date, next: next && next.text, nextDate: next && next.date };
  } catch (e) { console.log('espn schedule error:', e.message); return null; }
}

async function sportsSourceForTopic(topic) {
  const hit = await detectSportsTeam(topic);
  if (!hit) return null;
  const s = await fetchTeamSchedule(hit.lg, hit.team.id);
  if (!s || (!s.last && !s.next)) return null;
  let txt = 'Official ' + hit.lg.key.toUpperCase() + ' data for the ' + hit.team.name + '. ';
  if (s.last) txt += 'Most recent result: ' + s.last + (s.lastDate ? ' (' + String(s.lastDate).slice(0, 10) + ')' : '') + '. ';
  if (s.next) txt += 'Next game: ' + s.next + (s.nextDate ? ' (' + String(s.nextDate).slice(0, 10) + ')' : '') + '.';
  return {
    topic, publisher: 'ESPN', title: hit.team.name + ' — latest score & schedule',
    url: ESPN + '/' + hit.lg.sport + '/' + hit.lg.league + '/teams/' + hit.team.id,
    publishedAt: new Date().toISOString(), snippet: txt, fullText: txt, provider: 'espn_sports',
  };
}

/* ---- one topic, routed ------------------------------------------------- */
async function enrichArticle(url) {
  // Best-effort: pull the real article text so the writer has concrete facts
  // (scores, numbers, names) — RSS snippets alone are too thin. Dep-free,
  // short timeout, always falls back to the snippet on any failure.
  try {
    const r = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyCastBot/1.0; +https://mycast.app)' },
    }, { tries: 1, timeoutMs: 7000 });
    if (!r.ok) return '';
    const html = await r.text();
    const metaDesc = (html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#?[a-z0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return ((metaDesc ? metaDesc + ' ' : '') + body).slice(0, 1500);
  } catch (e) { return ''; }
}

async function retrieveForTopic(topic, windowKey) {
  const cacheKey = String(topic).toLowerCase() + '|' + windowKey;
  const cached = retrievalCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RETRIEVAL_TTL_MS) return cached.data;

  const hours = WINDOW_HOURS[windowKey] || 24;
  const cutoff = Date.now() - hours * 3600 * 1000;

  let results;
  if (MOCK_MODE) {
    const finance = isFinanceTopic(topic);
    results = [{
      topic,
      publisher: finance ? 'MarketWatch' : 'Reuters',
      title: 'Recent development in ' + topic,
      url: 'https://example.com/' + encodeURIComponent(topic),
      publishedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      snippet: 'Mock ' + (finance ? 'finance ' : '') + 'article about ' + topic + '.',
      provider: finance ? 'marketaux(mock)' : 'google_news(mock)',
    }];
  } else {
    const jobs = isFinanceTopic(topic)
      ? [fromMarketaux(topic, cutoff), fromGoogleNews(topic, cutoff), fromCurrents(topic, cutoff)]
      : [fromGoogleNews(topic, cutoff), fromCurrents(topic, cutoff)];
    const settled = await Promise.allSettled(jobs);
    results = [];
    for (const s of settled) if (s.status === 'fulfilled') results.push(...s.value);
    results = dedupeSources(results)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 6); // per-topic cap (keeps one broad topic from flooding the brief)
    // pull real article text for the top few so the writer has concrete facts
    await Promise.all(results.slice(0, 3).map(async (s) => { s.fullText = await enrichArticle(s.url); }));
  }
  // sports topics: lead with exact scores/schedule rather than vague news
  try { const sp = await sportsSourceForTopic(topic); if (sp) results = [sp, ...results]; } catch (e) {}
  retrievalCache.set(cacheKey, { at: Date.now(), data: results });
  return results;
}

/* ---- all topics -------------------------------------------------------- */
async function retrieveSources(topics, windowKey) {
  const perTopic = await Promise.all(topics.map(t => retrieveForTopic(t, windowKey)));
  const all = [];
  for (const arr of perTopic) all.push(...arr);
  return dedupeSources(all)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 40);
}

/* ---- one curated channel (runs its tuned queries, labels under channel) - */
async function retrieveForChannel(channelId, windowKey) {
  const ch = CHANNELS[channelId];
  if (!ch) return [];
  const cacheKey = 'ch:' + channelId + '|' + windowKey;
  const cached = retrievalCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RETRIEVAL_TTL_MS) return cached.data;

  const hours = WINDOW_HOURS[windowKey] || 24;
  const cutoff = Date.now() - hours * 3600 * 1000;

  let results;
  if (MOCK_MODE) {
    results = [{
      topic: ch.label, publisher: ch.finance ? 'MarketWatch' : 'Reuters',
      title: 'Top ' + ch.label + ' story', url: 'https://example.com/' + channelId,
      publishedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      snippet: 'Mock ' + ch.label + ' article.', provider: 'mock',
    }];
  } else {
    results = [];
    for (const q of ch.queries) {
      const jobs = ch.finance
        ? [fromMarketaux(q, cutoff), fromGoogleNews(q, cutoff)]
        : [fromGoogleNews(q, cutoff), fromCurrents(q, cutoff)];
      const settled = await Promise.allSettled(jobs);
      for (const s of settled) if (s.status === 'fulfilled') results.push(...s.value);
    }
    results = dedupeSources(results.map(r => Object.assign({}, r, { topic: ch.label })))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 6);
  }
  retrievalCache.set(cacheKey, { at: Date.now(), data: results });
  return results;
}

/* ---- combined: curated channels first, then custom topics -------------- */
async function retrieveAll(topics, channels, windowKey) {
  const chanArrs = await Promise.all((channels || []).map(c => retrieveForChannel(c, windowKey)));
  const topicArrs = await Promise.all((topics || []).map(t => retrieveForTopic(t, windowKey)));
  const all = [];
  for (const a of chanArrs) all.push(...a);   // channels lead
  for (const a of topicArrs) all.push(...a);  // then custom topics
  return dedupeSources(all).slice(0, 40);
}

/* =========================================================================
   RESILIENCE & CONCURRENCY (optimization)
   - Content-addressed audio cache: identical (voice, text) is synthesized
     once and then reused forever — never re-bills ElevenLabs for the same
     audio (replays, overlapping topics, retries all hit the cache).
   - Concurrency limiters cap simultaneous LLM/TTS calls so a burst of users
     can't overload the box or trip provider rate limits.
   - Retry-with-backoff + timeout wraps the flaky external calls.
   Tunable env: TTS_CONCURRENCY (3), LLM_CONCURRENCY (4).
   ========================================================================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeLimiter(max) {
  let active = 0; const q = [];
  const pump = () => {
    if (active >= max || q.length === 0) return;
    active++;
    const { fn, resolve, reject } = q.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); pump(); });
}
const ttsLimit = makeLimiter(parseInt(process.env.TTS_CONCURRENCY || '3', 10));
const llmLimit = makeLimiter(parseInt(process.env.LLM_CONCURRENCY || '4', 10));

async function fetchWithRetry(url, opts, cfg) {
  const { tries = 3, baseDelay = 500, timeoutMs = 30000 } = cfg || {};
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(to);
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(baseDelay * (2 ** i)); continue; }
      return r;
    } catch (e) {
      clearTimeout(to); lastErr = e;
      if (i < tries - 1) { await sleep(baseDelay * (2 ** i)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

function audioKey(voiceId, text) {
  return crypto.createHash('sha256').update(voiceId + '\n' + text).digest('hex');
}
let synthCount = 0; // real (non-cached) synth calls — observability / tests

/* =========================================================================
   SCRIPT WRITING (Claude) — grounded in retrieved sources for Briefs
   ========================================================================= */
async function callClaude(prompt, maxTokens) {
  if (MOCK_MODE) {
    return 'MOCK SCRIPT. ' + 'This is placeholder narration generated without API keys. '.repeat(40);
  }
  const r = await llmLimit(() => fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { tries: 3, timeoutMs: 60000 }));
  const d = await r.json();
  if (!d.content || !d.content[0]) throw new Error('Claude error: ' + JSON.stringify(d).slice(0, 300));
  return d.content[0].text.trim();
}

function sourcesBlock(sources) {
  if (!sources.length) return '(No recent sources were found in the chosen time window.)';
  const byTopic = {};
  for (const s of sources) { (byTopic[s.topic || 'General'] = byTopic[s.topic || 'General'] || []).push(s); }
  let out = '';
  for (const [topic, arr] of Object.entries(byTopic)) {
    out += '\n### SOURCES FOR TOPIC: ' + topic + '\n';
    arr.forEach((s, i) => {
      const body = (s.fullText && s.fullText.length > (s.snippet || '').length) ? s.fullText : (s.snippet || '');
      const when = s.publishedAt ? ' (' + s.publishedAt + ')' : '';
      out += (i + 1) + '. [' + s.publisher + ']' + when + ' ' + s.title + '\n';
      if (body) out += '   ' + body + '\n';
    });
  }
  return out;
}

async function writeBriefScript(topics, windowKey, sources, lengthMin) {
  const targetWords = Math.round(lengthMin * 160);
  const prompt =
    'PERSONA: You are "The Wire Editor" — a senior news editor with 20 years in broadcast journalism. ' +
    'You have synthesized thousands of breaking stories into clear, trustworthy briefings. You write the way ' +
    'the best wire services and morning shows do: fast, factual, never editorializing, always sourced. ' +
    'Write ONE script of about ' + targetWords + ' words.\n\n' +
    'Cover these topics IN THIS ORDER, each as its own clear section:\n' +
    topics.map((t, i) => (i + 1) + '. ' + t).join('\n') + '\n\n' +
    'HOW TO REPORT (this is the whole job):\n' +
    '- INVERTED PYRAMID: Lead each topic with the single most important, most RECENT concrete development, then add supporting detail in descending importance. The listener should get the headline even if they only catch the first sentence.\n' +
    '- NAMED ATTRIBUTION MID-STORY: Weave the source into the sentence as you report it — "Reuters reports the central bank raised rates" not a citation tacked on at the end. This builds trust as the listener hears it, not after.\n' +
    '- Be specific and factual. Pull the hard facts out of the sources: final scores, numbers, dollar amounts, names, dates, who did what, and what it means. ' +
    'A line like "the Dodgers played" is worthless; "the Dodgers beat the Giants 5-3 last night, their fourth straight win" is the job. If the sources contain a number, a score, or a result, SAY IT.\n' +
    '- CONNECT THE DOTS: If two topics relate to the same underlying event or trend, draw that connection explicitly rather than treating each topic as an isolated silo.\n' +
    '- Prefer the newest sources; if sources conflict, go with the most recent. Mention roughly when something happened ("last night," "Tuesday") when the sources show it.\n' +
    '- WHY IT MATTERS: Close each story with one sentence connecting it to listener relevance or what happens next — the way a good anchor frames stakes, not just facts.\n\n' +
    'HARD RULES:\n' +
    '- Use ONLY the source material below, grouped by topic; for each topic use only that topic\'s sources.\n' +
    '- IGNORE sources not clearly about the topic (the feed sometimes returns loosely-related items).\n' +
    '- Do NOT invent facts, numbers, or quotes. But DO surface every concrete fact that is actually present in the sources — vagueness when the facts are right there is the main failure to avoid.\n' +
    '- If a topic genuinely has no relevant sources, say so in one short sentence and move on.\n\n' +
    'STYLE & VOICE:\n' +
    '- Narrator persona: warm but authoritative, like a trusted morning anchor — never robotic, never overly casual.\n' +
    '- Open with a half-sentence intro naming the topics, then get straight to the news. No filler like "let\'s dive in" or "without further ado."\n' +
    '- Ban stale transitions: never start consecutive stories with "In other news," "Meanwhile," or "Moving on." Vary the connective tissue between stories.\n' +
    '- Keep sentences SHORT for natural text-to-speech delivery — one clear idea per sentence reads far better aloud than long compound clauses.\n' +
    '- Spoken aloud — brisk, natural transitions, no headers, no bullet points, no stage directions. Spend proportionally more time on earlier topics. End with a short sign-off.\n\n' +
    'SOURCE MATERIAL (grouped by topic; published within the last ' + (WINDOW_HOURS[windowKey] || 24) + ' hours; each item may include the article text):\n' +
    sourcesBlock(sources);
  return callClaude(prompt, 8192);
}

/* =========================================================================
   DEEP DIVE REFERENCES — real, citable grounding for Deep Dives.
   Layered providers (graceful):
     - Tavily (if TAVILY_API_KEY set): broad, credible, LLM-ready web sources.
     - Wikipedia (keyless): always-on encyclopedic backbone.
   Combined, deduped, capped. If Tavily isn't configured or fails, Wikipedia
   carries it; if both fail, the episode still generates (no sources).
   Optional env: TAVILY_API_KEY
   ========================================================================= */
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

async function retrieveWikipedia(topic) {
  const refs = [];
  const UA = { 'User-Agent': 'MyCast/1.0 (contact: support@mycast.app)' };
  try {
    const sr = await fetchWithRetry(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=' + encodeURIComponent(topic),
      { headers: UA }, { tries: 2, timeoutMs: 8000 });
    const sd = await sr.json();
    const titles = ((sd.query && sd.query.search) || []).map(x => x.title);
    for (const title of titles) {
      try {
        const pr = await fetchWithRetry(
          'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
          { headers: UA }, { tries: 2, timeoutMs: 8000 });
        const pd = await pr.json();
        if (pd && pd.extract) {
          refs.push({
            publisher: 'Wikipedia', title: pd.title || title,
            url: (pd.content_urls && pd.content_urls.desktop && pd.content_urls.desktop.page)
              || 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
            snippet: String(pd.extract).slice(0, 600), provider: 'wikipedia',
          });
        }
      } catch (e) { /* skip this page */ }
    }
  } catch (e) { console.log('wikipedia reference error:', e.message); }
  return refs;
}

async function retrieveTavily(topic) {
  if (!TAVILY_API_KEY) return [];
  try {
    const r = await fetchWithRetry('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query: topic, search_depth: 'basic', max_results: 6 }),
    }, { tries: 2, timeoutMs: 12000 });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).map(x => ({
      publisher: hostnameOf(x.url) || 'Web', title: x.title, url: x.url,
      snippet: String(x.content || '').slice(0, 600), provider: 'tavily',
    }));
  } catch (e) { console.log('tavily error:', e.message); return []; }
}


async function retrieveSemanticScholar(topic, expert) {
  expert = expert || false;
  var fields = 'title,abstract,year,authors,url,externalIds,venue,citationCount';
  var url = 'https://api.semanticscholar.org/graph/v1/paper/search?query=' +
    encodeURIComponent(topic) + '&limit=8&fields=' + fields;
  try {
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 8000);
    var res = await fetch(url, {
      headers: { 'User-Agent': 'MyCast/1.0', 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    var data = await res.json();
    var papers = (data && data.data ? data.data : []).filter(function(p) { return p && p.title; });
    papers.sort(function(a, b) {
      return expert ? (b.year || 0) - (a.year || 0) : (b.citationCount || 0) - (a.citationCount || 0);
    });
    return papers.slice(0, 5).map(function(p) {
      var authorNames = (p.authors || []).map(function(a) { return a.name; }).filter(Boolean);
      var authors = authorNames[0] || null;
      if (authorNames.length === 2) authors = authorNames.join(' & ');
      else if (authorNames.length > 2) authors = authorNames[0] + ' et al.';
      var abstract = p.abstract ? p.abstract.slice(0, 500).trimEnd() + '...' : '';
      return {
        publisher: p.venue || 'Semantic Scholar',
        title: p.title,
        url: p.url || (p.externalIds && p.externalIds.DOI ? 'https://doi.org/' + p.externalIds.DOI : null),
        snippet: (authors && p.year ? '(' + authors + ', ' + p.year + ') ' : '') + abstract,
        provider: 'semantic_scholar',
      };
    });
  } catch (e) {
    console.warn('[research] Semantic Scholar failed:', e.message);
    return [];
  }
}


/* ---- PubMed (NIH, peer-reviewed medical & life science, no key needed) --- */
async function retrievePubMed(topic) {
  try {
    var searchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=' +
      encodeURIComponent(topic) + '&retmax=5&retmode=json&sort=relevance';
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 8000);
    var searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'MyCast/1.0' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!searchRes.ok) return [];
    var searchData = await searchRes.json();
    var ids = (searchData.esearchresult && searchData.esearchresult.idlist) ? searchData.esearchresult.idlist : [];
    if (!ids.length) return [];
    var summaryUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=' +
      ids.join(',') + '&retmode=json';
    var ctrl2 = new AbortController();
    var t2 = setTimeout(function() { ctrl2.abort(); }, 8000);
    var summaryRes = await fetch(summaryUrl, { headers: { 'User-Agent': 'MyCast/1.0' }, signal: ctrl2.signal });
    clearTimeout(t2);
    if (!summaryRes.ok) return [];
    var summaryData = await summaryRes.json();
    var result = summaryData.result || {};
    return ids.map(function(pmid) {
      var art = result[pmid];
      if (!art || !art.title) return null;
      var authors = art.authors && art.authors.length ? art.authors[0].name + (art.authors.length > 1 ? ' et al.' : '') : null;
      return {
        publisher: art.source || 'PubMed',
        title: art.title,
        url: 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
        snippet: (authors ? '(' + authors + (art.pubdate ? ', ' + art.pubdate.slice(0,4) : '') + ') ' : '') + 'Published in ' + (art.source || 'PubMed') + '.',
        provider: 'pubmed',
      };
    }).filter(Boolean);
  } catch (e) {
    console.warn('[research] PubMed failed:', e.message);
    return [];
  }
}

/* ---- arXiv (cutting-edge research, CS/math/physics/economics, no key) ---- */
async function retrieveArXiv(topic) {
  try {
    var url = 'https://export.arxiv.org/api/query?search_query=all:' +
      encodeURIComponent(topic) + '&start=0&max_results=5&sortBy=relevance';
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 8000);
    var res = await fetch(url, { headers: { 'User-Agent': 'MyCast/1.0' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    var text = await res.text();
    var entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
    return entries.slice(0, 5).map(function(entry) {
      var titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      var summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      var linkMatch = entry.match(/href="(https:\/\/arxiv\.org\/abs\/[^"]+)"/);
      var authorMatch = entry.match(/<name>([\s\S]*?)<\/name>/);
      var yearMatch = entry.match(/<published>(\d{4})/);
      if (!titleMatch) return null;
      var title = titleMatch[1].trim().replace(/\s+/g, ' ');
      var summary = summaryMatch ? summaryMatch[1].trim().replace(/\s+/g, ' ').slice(0, 400) + '...' : '';
      var author = authorMatch ? authorMatch[1].trim() : null;
      var year = yearMatch ? yearMatch[1] : null;
      return {
        publisher: 'arXiv',
        title: title,
        url: linkMatch ? linkMatch[1] : null,
        snippet: (author && year ? '(' + author + ', ' + year + ') ' : '') + summary,
        provider: 'arxiv',
      };
    }).filter(Boolean);
  } catch (e) {
    console.warn('[research] arXiv failed:', e.message);
    return [];
  }
}

async function retrieveReferences(topic) {
  if (MOCK_MODE) {
    const out = [{
      publisher: 'Wikipedia', title: topic + ' (overview)',
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(topic).replace(/ /g, '_')),
      snippet: 'Mock reference extract about ' + topic + '.', provider: 'wikipedia',
    }];
    if (TAVILY_API_KEY) out.unshift({
      publisher: 'example.com', title: 'Web reference: ' + topic, url: 'https://example.com/' + encodeURIComponent(topic),
      snippet: 'Mock web reference about ' + topic + '.', provider: 'tavily',
    });
    return out;
  }
  const [web, wiki, scholar, pubmed, arxiv] = await Promise.all([
    retrieveTavily(topic), retrieveWikipedia(topic), retrieveSemanticScholar(topic),
    retrievePubMed(topic), retrieveArXiv(topic)
  ]);
  return dedupeSources([...scholar, ...pubmed, ...arxiv, ...web, ...wiki]).slice(0, 15); // academic sources lead
}

function referencesBlock(refs) {
  if (!refs.length) return '(No reference material was retrieved. Rely on well-established general knowledge and avoid stating specific facts, dates, names, or numbers you are not confident are correct.)';
  return refs.map((r, i) => (i + 1) + '. [' + r.publisher + '] ' + r.title + ' — ' + (r.snippet || '')).join('\n');
}

async function writeDeepDivePlan(topic, depthKey) {
  const n = (DEPTH[depthKey] || DEPTH.conversational).episodes;
  if (MOCK_MODE) {
    return Array.from({ length: n }, (_, i) => 'Part ' + (i + 1) + ': ' + topic);
  }
  const prompt =
    'PERSONA: You are "The Curriculum Architect" — an expert instructional designer who has built learning ' +
    'paths for top universities and professional training programs. You understand how people actually learn: ' +
    'progressively, with each concept scaffolded on the last, never assuming prior knowledge the learner hasn\'t earned yet.\n\n' +
    'Plan a ' + n + '-episode audio mini-series that takes a listener from zero to "' +
    (DEPTH[depthKey] || DEPTH.conversational).label + '" knowledge of: ' + topic + '.\n' +
    'PEDAGOGICAL STRUCTURE: Order episodes so foundational concepts come first and advanced applications come last. ' +
    'Each episode title should signal what specific capability or understanding the listener gains — not just a topic label.\n' +
    'Return ONLY the ' + n + ' episode titles, one per line, no numbering, no extra text. ' +
    'Order them so each builds on the last.';
  const text = await callClaude(prompt, 1024);
  const titles = text.split('\n').map(t => t.replace(/^\s*[-\d.)]+\s*/, '').trim()).filter(Boolean);
  while (titles.length < n) titles.push(topic + ' — Part ' + (titles.length + 1));
  return titles.slice(0, n);
}

async function writeEpisodeScript(seriesTopic, episodeTitle, lengthMin, idxOfN, refs, priorEpisodeTitles) {
  const targetWords = Math.round(lengthMin * 160);
  const priorContext = (priorEpisodeTitles && priorEpisodeTitles.length)
    ? 'Episodes already covered in this series (you may reference and build on these, do not re-teach them): ' + priorEpisodeTitles.join('; ') + '.\n\n'
    : '';
  const prompt =
    'PERSONA: You are "The Curriculum Architect" — an expert instructional designer and teacher who makes ' +
    'complex topics genuinely click for learners. You ground every lesson in real research, never just general knowledge.\n\n' +
    'Write a spoken-word podcast script of about ' + targetWords + ' words for episode "' + episodeTitle +
    '" in a mini-series teaching: ' + seriesTopic + ' (' + idxOfN + ').\n\n' +
    priorContext +
    'TEACHING METHOD (this is the whole job):\n' +
    '- PREREQUISITE AWARENESS: Build directly on what prior episodes established. Reference earlier concepts by name when relevant, the way a good course reinforces earlier material.\n' +
    '- DEFINE JARGON ON FIRST USE: You are an expert, but the listener may not be. The first time you introduce a technical term, define it in one clear phrase before moving on.\n' +
    '- CONCRETE ANALOGIES: When explaining findings from the reference material, translate them into a vivid mental model or comparison the listener can hold onto — not just a restatement of the study.\n' +
    '- CITE REAL RESEARCH BY NAME: When the reference material includes a specific study, researcher, or finding, name it directly ("Stanford researcher BJ Fogg found...") rather than vague phrasing like "studies show."\n' +
    '- SYNTHESIS CLOSE: End the episode with a question or challenge the listener should be able to answer if they absorbed the material — reinforcing active learning, not passive listening.\n\n' +
    'Ground the episode in the REFERENCE MATERIAL below. You may add well-established general knowledge to ' +
    'explain and connect ideas, but do NOT invent specific facts, dates, names, statistics, or quotes that ' +
    'are not supported by the references or that you are not confident are correct.\n\n' +
    'STYLE: Conversational and clear, no headers or bullet points, written to be heard not read. Keep sentences ' +
    'short for natural text-to-speech delivery. Briefly connect to the series arc, teach the core ideas with ' +
    'concrete examples, and end with a one-line bridge to what comes next.\n\n' +
    'REFERENCE MATERIAL:\n' + referencesBlock(refs || []);
  return callClaude(prompt, 8192);
}

/* =========================================================================
   SEGMENTATION + SYNTHESIS (fast start)
   ========================================================================= */
function splitIntoSegments(scriptText, wordsPerSegment) {
  const wps = wordsPerSegment || 200;
  // split on sentence boundaries, then pack into ~wps-word segments
  const sentences = scriptText.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|\S+$/g) || [scriptText];
  const segments = [];
  let buf = [];
  let count = 0;
  for (const s of sentences) {
    const w = s.trim().split(' ').length;
    buf.push(s.trim());
    count += w;
    if (count >= wps) { segments.push(buf.join(' ')); buf = []; count = 0; }
  }
  if (buf.length) segments.push(buf.join(' '));
  return segments.length ? segments : [scriptText];
}

async function synthesizeToFile(text, voiceId) {
  // content-addressed: identical (voice, text) reuses the same file forever
  const key = audioKey(voiceId, text);
  const fileName = key + '.mp3';
  const filePath = path.join(AUDIO_DIR, fileName);
  if (fs.existsSync(filePath)) {
    return { fileId: key, url: '/audio/' + fileName, cached: true }; // cache hit — no API call, no bill
  }
  if (MOCK_MODE) {
    fs.writeFileSync(filePath, Buffer.from('MOCK_AUDIO_' + key));
    synthCount++;
    return { fileId: key, url: '/audio/' + fileName, bytes: 0, cached: false };
  }
  const voice = resolveVoice(voiceId);
  const r = await ttsLimit(() => fetchWithRetry('https://api.elevenlabs.io/v1/text-to-speech/' + voice.id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': EK },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  }, { tries: 3, timeoutMs: 45000 }));
  if (!r.ok) throw new Error('ElevenLabs ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  synthCount++;
  return { fileId: key, url: '/audio/' + fileName, bytes: buf.length, cached: false };
}

function absolute(url) { return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + url : url; }

/* Generate ALL segments for one episode, in order, marking each ready as it
   finishes so the player can start on segment 1 immediately. Persists after
   each segment so the manifest reflects progress even after a restart.      */
/* Classify a TTS failure so the app can show a useful message and we can
   stop hammering a provider that's globally failing (bad key / no credits). */
function classifyTtsError(msg) {
  const m = String(msg || '').toLowerCase();
  if (m.includes('quota') || m.includes('credit') || m.includes('exceeded') || m.includes('insufficient'))
    return { code: 'tts_quota', label: 'Audio service is out of credits', fatal: true };
  if (m.includes('401') || m.includes('403') || m.includes('unauthor') || m.includes('invalid') || m.includes('api key') || m.includes('api_key'))
    return { code: 'tts_auth', label: 'Audio service rejected the API key', fatal: true };
  if (m.includes('429') || m.includes('rate'))
    return { code: 'tts_rate', label: 'Audio service is rate-limited', fatal: false };
  return { code: 'tts_error', label: 'Audio service error', fatal: false };
}

async function generateEpisodeSegments(ep, scriptText) {
  const parts = splitIntoSegments(scriptText, 200);
  ep.segments = parts.map((_, i) => ({ index: i + 1, status: 'pending', audioUrl: null }));
  await store.updateEpisode(ep);
  for (let i = 0; i < parts.length; i++) {
    try {
      const { url } = await synthesizeToFile(parts[i], ep.voiceId);
      ep.segments[i].status = 'ready';
      ep.segments[i].audioUrl = absolute(url);
      ep.segments[i].text = parts[i];
    } catch (e) {
      ep.segments[i].status = 'failed';
      ep.segments[i].error = e.message;
      const cls = classifyTtsError(e.message);
      ep.error = cls.label;          // top-level reason the app can show
      ep.errorCode = cls.code;       // machine-readable: tts_quota | tts_auth | tts_rate | tts_error
      console.log('segment synth failed [' + cls.code + ']:', e.message);
      if (cls.fatal) {
        // bad key / no credits won't fix itself across segments — stop now
        for (let j = i + 1; j < parts.length; j++) {
          ep.segments[j].status = 'failed';
          ep.segments[j].error = 'aborted: ' + cls.code;
        }
        await store.updateEpisode(ep);
        break;
      }
    }
    await store.updateEpisode(ep); // persist progress segment-by-segment
  }
  const anyReady = ep.segments.some(s => s.status === 'ready');
  const allReady = ep.segments.every(s => s.status === 'ready');
  ep.status = allReady ? 'complete' : (anyReady ? 'partial' : 'failed');
  if (allReady) { ep.error = undefined; ep.errorCode = undefined; }
  await store.updateEpisode(ep);
}

/* =========================================================================
   REUSABLE BRIEF PIPELINE (used by the endpoint AND the scheduler)
   ========================================================================= */
async function buildBriefEpisode(user, cfg, opts) {
  const { topics, channels, window = '24h', lengthMin = 10, voiceId = 'josh' } = cfg || {};
  const cleanTopics = (topics || []).map(t => String(t).trim()).filter(Boolean).slice(0, 10);
  const cleanChannels = (channels || []).filter(c => CHANNELS[c]).slice(0, 10);

  // Track popularity for shared, topic-free combos (used by the 12h pre-cache job)
  trackComboPopularity(cleanChannels, cleanTopics, lengthMin);

  // Serve from the 12h pre-generated cache if this exact shared combo was
  // already built recently — instant response instead of ~60s live generation.
  if (!cleanTopics.length && cleanChannels.length) {
    const cachedEp = getCachedPopularEpisode(cleanChannels, lengthMin);
    if (cachedEp) {
      console.log('popular combo cache HIT:', comboKey(cleanChannels, lengthMin));
      // Clone the cached episode as a fresh library entry for this user
      const epId = id('ep');
      const clone = Object.assign({}, cachedEp, {
        id: epId, userId: user.id, status: cachedEp.status,
        createdAt: now(),
      });
      await store.saveEpisode(clone);
      await store.addToLibrary({ type: 'brief', id: epId, title: clone.title, createdAt: clone.createdAt, userId: user.id });
      return clone;
    }
  }

  const sectionLabels = [...cleanChannels.map(c => CHANNELS[c].label), ...cleanTopics];
  const epId = id('ep');
  const ep = {
    id: epId, mode: 'brief', userId: user.id, status: 'generating',
    title: 'Your Brief — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    topics: cleanTopics, channels: cleanChannels, window, lengthMin, voiceId,
    segments: [], sources: [], createdAt: now(),
  };
  await store.saveEpisode(ep);
  const run = (async () => {
    try {
      ep.sources = await retrieveAll(cleanTopics, cleanChannels, window);
      await store.updateEpisode(ep);
      const script = await writeBriefScript(sectionLabels, window, ep.sources, lengthMin);
      await generateEpisodeSegments(ep, script);
      await store.addToLibrary({ type: 'brief', id: epId, title: ep.title, createdAt: ep.createdAt, userId: user.id });
      // Populate the popular-combo cache for shared, topic-free combos so the
      // next user requesting the same combo gets an instant cached result.
      if (!cleanTopics.length && cleanChannels.length && ep.status === 'ready') {
        popularComboCache.set(comboKey(cleanChannels, lengthMin), { at: Date.now(), episode: ep });
      }
    } catch (e) {
      ep.status = 'failed'; ep.error = e.message;
      await store.updateEpisode(ep);
      console.log('brief pipeline failed:', e.message);
    }
  })();
  if (opts && opts.await) await run;
  return ep;
}

/* =========================================================================
   SCHEDULER — pre-generates Pro users' briefs ahead of their chosen times,
   in their timezone, so the episode is ready when they open the app.
   A tick runs every minute. For each schedule, if the user is still Pro and
   the local time is within the run window for a scheduled time (and it hasn't
   already run today), it kicks off a brief. The episode generates in the
   background (fast-start applies), and the schedule records the episode id so
   the app can surface "your brief is ready" via GET /api/today.
   ========================================================================= */
const SCHED_LEAD_MIN = 10;   // start up to 10 min before the target time
const SCHED_WINDOW_MIN = 60; // ...and still catch up to 60 min after (if worker was down)

function localParts(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
    return { date: p.year + '-' + p.month + '-' + p.day, minutesOfDay: hour * 60 + parseInt(p.minute, 10) };
  } catch (e) {
    const d = new Date();
    return { date: d.toISOString().slice(0, 10), minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

function dueTimes(schedule, lp) {
  const due = [];
  for (const t of schedule.times || []) {
    const [hh, mm] = String(t).split(':').map(Number);
    const target = (hh || 0) * 60 + (mm || 0);
    const already = (schedule.lastRuns || {})[t] === lp.date;
    if (!already && lp.minutesOfDay >= target - SCHED_LEAD_MIN && lp.minutesOfDay <= target + SCHED_WINDOW_MIN) {
      due.push(t);
    }
  }
  return due;
}

async function tickSchedules() {
  const all = await store.listAllSchedules();
  for (const sc of all) {
    const user = await store.getUser(sc.userId);
    if (!user || TIER_RANK[user.tier] < TIER_RANK['pro']) continue; // Pro-only; skip if downgraded
    const lp = localParts(sc.timezone);
    for (const t of dueTimes(sc, lp)) {
      try {
        const ep = await buildBriefEpisode(user, sc.config, { await: false });
        sc.lastRuns = Object.assign({}, sc.lastRuns, { [t]: lp.date });
        sc.lastEpisodeId = ep.id;
        sc.lastGeneratedDate = lp.date;
        await store.saveSchedule(sc);
        console.log('scheduled brief generated:', sc.userId, t, '->', ep.id);
      } catch (e) {
        console.log('schedule run failed:', e.message);
      }
    }
  }
}

/* =========================================================================
   ENDPOINTS
   ========================================================================= */

app.get('/api/health', (req, res) => res.json({ ok: true, version: 'v9.15', mock: MOCK_MODE, db: USE_DB }));

// One-shot TTS probe: synthesizes a tiny clip so you can verify the ElevenLabs
// key/credits without generating a whole episode. Returns the exact failure
// reason if it fails. Gated behind ADMIN_TOKEN when one is configured.
app.get('/api/diag/tts', async (req, res) => {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'admin token required' });
  if (MOCK_MODE) return res.json({ ok: true, mock: true, note: 'MOCK_MODE active — no real keys set, so synthesis is placeholder.' });
  try {
    const { bytes } = await synthesizeToFile('This is a test.', 'josh');
    res.json({ ok: true, bytes, note: 'ElevenLabs synthesized successfully — key and credits are good.' });
  } catch (e) {
    const cls = classifyTtsError(e.message);
    res.json({ ok: false, code: cls.code, reason: cls.label, detail: String(e.message).slice(0, 300) });
  }
});

app.get('/api/voices', (req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([key, v]) => ({
      id: key, displayName: v.displayName, gender: v.gender, tier: v.tier,
    })),
  });
});

// Curated channels for the preset tiles (id + label). The app sends selected
// ids in the `channels` array of POST /api/brief.
app.get('/api/channels', (req, res) => {
  res.json({ channels: Object.entries(CHANNELS).map(([id, c]) => ({ id, label: c.label })) });
});

/* ----- accounts --------------------------------------------------------- */
// App calls this once on first launch, stores the token, and sends it as
// "Authorization: Bearer <token>" on every request thereafter.
app.post('/api/auth/register', async (req, res) => {
  const u = {
    id: id('usr'),
    token: crypto.randomBytes(24).toString('hex'),
    tier: 'free', gen_count: 0, period_start: periodKey(),
  };
  await store.createUser(u);
  res.json({ userId: u.id, token: u.token, tier: u.tier });
});

// The app reads this for the "X left this month" counter.
app.get('/api/me', async (req, res) => {
  const user = await getReqUser(req);
  ensurePeriod(user);
  const lim = limitFor(user.tier);
  res.json({
    userId: user.id, tier: user.tier,
    used: user.gen_count,
    limit: lim === Infinity ? 'unlimited' : lim,
    remaining: lim === Infinity ? 'unlimited' : Math.max(0, lim - user.gen_count),
    resetsMonthly: true,
  });
});

// Billing seam: RevenueCat/Stripe (or you, manually) set a user's tier here.
/* ----- billing/refresh — app calls this on launch to sync Pro status ------- */
app.post('/api/billing/refresh', async (req, res) => {
  const user = await getReqUser(req);
  // Developer accounts are always Pro — never let RevenueCat overwrite this
  if (DEVELOPER_IDS.includes(user.id)) {
    return res.json({ userId: user.id, tier: 'pro', synced: true, note: 'developer account' });
  }
  const { appUserId } = req.body || {};
  const rcUserId = appUserId || user.id;
  const RC_SECRET = process.env.REVENUECAT_SECRET_KEY || '';
  if (!RC_SECRET) {
    return res.json({ userId: user.id, tier: user.tier, synced: false, note: 'REVENUECAT_SECRET_KEY not configured' });
  }
  try {
    const rcRes = await fetchWithRetry(
      'https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(rcUserId),
      { headers: { 'Authorization': 'Bearer ' + RC_SECRET, 'Content-Type': 'application/json' } },
      { tries: 2, timeoutMs: 10000 }
    );
    if (!rcRes.ok) {
      console.log('billing/refresh: RC lookup failed', rcRes.status, rcUserId);
      return res.json({ userId: user.id, tier: user.tier, synced: false });
    }
    const rcData = await rcRes.json();
    const entitlements = (rcData.subscriber || {}).entitlements || {};
    const nowIso = new Date().toISOString();
    let tier = 'free';
    if (entitlements['pro'] && entitlements['pro'].expires_date > nowIso) tier = 'pro';
    else if (entitlements['plus'] && entitlements['plus'].expires_date > nowIso) tier = 'plus';
    if (tier !== user.tier) {
      await setUserTier(user.id, tier);
      console.log('billing/refresh: ' + rcUserId + ' -> ' + tier);
    }
    res.json({ userId: user.id, tier, synced: true });
  } catch (e) {
    console.error('billing/refresh error:', e.message);
    res.json({ userId: user.id, tier: user.tier, synced: false, error: e.message });
  }
});

app.post('/api/admin/set-tier', async (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ error: 'forbidden' });
  const { userId, tier } = req.body || {};
  if (!['free', 'plus', 'pro'].includes(tier)) return res.status(400).json({ error: 'bad tier' });
  const ok = await setUserTier(userId, tier);
  if (!ok) return res.status(404).json({ error: 'no such user' });
  res.json({ userId, tier });
});

/* RevenueCat webhook — billing source of truth. The app must set RevenueCat's
   appUserID to the MyCast user.id (the one from /api/auth/register) so events
   map to the right account. Configure the webhook URL + Authorization header in
   RevenueCat, and set REVENUECAT_WEBHOOK_TOKEN to that same value. Always 200s
   (even on no-op/user-not-found) so RevenueCat doesn't retry forever. */
app.post('/api/revenuecat/webhook', async (req, res) => {
  if (REVENUECAT_WEBHOOK_TOKEN) {
    const auth = req.headers['authorization'] || '';
    if (auth !== REVENUECAT_WEBHOOK_TOKEN && auth !== 'Bearer ' + REVENUECAT_WEBHOOK_TOKEN)
      return res.status(401).json({ error: 'unauthorized' });
  }
  const ev = (req.body && req.body.event) || {};
  const type = ev.type || '';
  const userId = ev.app_user_id || ev.original_app_user_id;
  if (!userId) return res.json({ ok: true, ignored: 'no app_user_id' });

  let tier = null;
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE':
      tier = tierFromRevenueCat(ev); break;
    case 'EXPIRATION':
      tier = 'free'; break;                 // access actually ended -> downgrade
    case 'CANCELLATION':                     // auto-renew off, still has access until expiry
    case 'BILLING_ISSUE':                    // grace period — don't yank access yet
    default:
      tier = null; break;                    // no tier change
  }

  if (!tier) {
    console.log('revenuecat ' + type + ' -> no tier change (' + userId + ')');
    return res.json({ ok: true, type, tier: 'unchanged' });
  }
  const applied = await setUserTier(userId, tier);
  console.log('revenuecat ' + type + ' -> ' + userId + ' tier=' + tier + (applied ? '' : ' (user not found)'));
  res.json({ ok: true, type, userId, tier, applied });
});

/* ----- GET BRIEFED ------------------------------------------------------ */
app.post('/api/brief', async (req, res) => {
  const { topics = [], channels = [], window = '24h', lengthMin = 10, voiceId = 'josh' } = req.body || {};
  const cleanTopics = topics.map(t => String(t).trim()).filter(Boolean).slice(0, 10);
  const cleanChannels = (channels || []).filter(c => CHANNELS[c]).slice(0, 10);
  if (!cleanTopics.length && !cleanChannels.length) return res.status(400).json({ error: 'Add at least one topic or channel.' });
  if (!WINDOW_HOURS[window]) return res.status(400).json({ error: 'Invalid window.' });

  const user = await getReqUser(req);
  if (!voiceAllowed(user, voiceId))
    return res.status(403).json({ error: 'voice_locked', message: 'That voice needs a paid plan.' });
  if (!(await reserveGeneration(user, 1)))
    return res.status(402).json({ error: 'limit_reached', message: 'Monthly limit reached.', tier: user.tier });

  const ep = await buildBriefEpisode(user, { topics: cleanTopics, channels: cleanChannels, window, lengthMin, voiceId });
  res.json({ episodeId: ep.id, status: ep.status });
});

/* ----- DEEP DIVE -------------------------------------------------------- */
/* Evergreen deep-dive reuse -------------------------------------------------
   Deep dives are general knowledge and expensive to synthesize. We tag each
   finished series with a normalized signature and clone a matching one for the
   next user instead of regenerating — reusing the already-synthesized (and
   content-addressed) audio files. Zero LLM, zero TTS, instant, frontend-blind. */
function normTopic(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
function deepdiveSig(topic, depth, lengthMin, voiceId) {
  return normTopic(topic) + '|' + depth + '|' + lengthMin + '|' + voiceId;
}
async function cloneSeriesForUser(src, user) {
  const newSerId = id('ser');
  const episodes = [];
  for (const ref of src.episodes) {
    const srcEp = await store.getEpisode(ref.id);
    if (!srcEp) continue;
    const copy = JSON.parse(JSON.stringify(srcEp));
    copy.id = id('ep'); copy.userId = user.id; copy.seriesId = newSerId; copy.createdAt = now();
    await store.saveEpisode(copy);
    episodes.push({ id: copy.id, index: copy.index, title: copy.title, status: copy.status });
  }
  const newSeries = JSON.parse(JSON.stringify(src));
  newSeries.id = newSerId; newSeries.userId = user.id; newSeries.episodes = episodes;
  newSeries.createdAt = now(); newSeries.clonedFrom = src.id;
  delete newSeries.sig; delete newSeries.reusable; // the clone is not itself a template
  await store.saveSeries(newSeries);
  await store.addToLibrary({ type: 'deepdive', id: newSerId, title: newSeries.topic, createdAt: newSeries.createdAt, userId: user.id });
  return newSeries;
}

app.post('/api/deepdive', async (req, res) => {
  const { topic, depth = 'conversational', episodeLengthMin = 20, voiceId = 'josh' } = req.body || {};
  const t = String(topic || '').trim();
  if (!t) return res.status(400).json({ error: 'Enter a topic.' });
  if (!DEPTH[depth]) return res.status(400).json({ error: 'Invalid depth.' });

  const user = await getReqUser(req);
  if (!voiceAllowed(user, voiceId))
    return res.status(403).json({ error: 'voice_locked', message: 'That voice needs a paid plan.' });
  if (depth === 'black_belt' && TIER_RANK[user.tier] < TIER_RANK[BLACK_BELT_MIN_TIER])
    return res.status(403).json({ error: 'feature_locked', message: 'Black Belt needs a paid plan.' });
  if (!(await reserveGeneration(user, DEEPDIVE_COUNTS_AS)))
    return res.status(402).json({ error: 'limit_reached', message: 'Monthly limit reached.', tier: user.tier });

  // Evergreen reuse: if an identical series already exists, clone it (no LLM/TTS).
  const sig = deepdiveSig(t, depth, episodeLengthMin, voiceId);
  const shared = await store.findSharedSeries(sig);
  if (shared) {
    const cloned = await cloneSeriesForUser(shared, user);
    console.log('deepdive cache HIT [' + sig + '] -> cloned ' + cloned.id);
    return res.json({ seriesId: cloned.id, firstEpisodeId: cloned.episodes[0].id, plannedEpisodes: cloned.episodes, cached: true });
  }

  const serId = id('ser');
  const series = {
    id: serId, userId: user.id, topic: t, depth, episodeLengthMin, voiceId,
    label: DEPTH[depth].label, episodes: [], createdAt: now(), status: 'planning', sig,
  };
  await store.saveSeries(series);

  let titles;
  try { titles = await writeDeepDivePlan(t, depth); }
  catch (e) { return res.status(500).json({ error: 'Planning failed: ' + e.message }); }

  // create episode shells
  series.episodes = [];
  for (let i = 0; i < titles.length; i++) {
    const epId = id('ep');
    const ep = {
      id: epId, mode: 'deepdive', userId: user.id, seriesId: serId, index: i + 1, title: titles[i],
      status: 'queued', voiceId, lengthMin: episodeLengthMin,
      segments: [], sources: [], createdAt: now(),
    };
    await store.saveEpisode(ep);
    series.episodes.push({ id: epId, index: i + 1, title: titles[i], status: 'queued' });
  }
  series.status = 'generating';
  await store.updateSeries(series);
  const firstId = series.episodes[0].id;
  res.json({ seriesId: serId, firstEpisodeId: firstId, plannedEpisodes: series.episodes });

  // generate episode 1 first (fast start), then the rest in the background
  (async () => {
    const refs = await retrieveReferences(t);     // real, citable grounding for the whole series
    series.sources = refs;
    await store.updateSeries(series);
    for (let i = 0; i < series.episodes.length; i++) {
      const ref = series.episodes[i];
      const ep = await store.getEpisode(ref.id);
      ep.status = 'generating'; ref.status = 'generating';
      ep.sources = refs;                          // show the references on each episode
      await store.updateSeries(series);
      try {
        const priorTitles = series.episodes.slice(0, i).map(e => e.title);
        const script = await writeEpisodeScript(t, ep.title, episodeLengthMin, (i + 1) + ' of ' + series.episodes.length, refs, priorTitles);
        await generateEpisodeSegments(ep, script);
        ref.status = ep.status;
      } catch (e) {
        ep.status = 'failed'; ep.error = e.message; ref.status = 'failed';
        await store.updateEpisode(ep);
        console.log('deepdive episode failed:', e.message);
      }
      await store.updateSeries(series);
    }
    series.status = 'complete';
    // Only a fully-successful series becomes a reusable template (never cache a
    // series whose audio failed — e.g. a TTS-quota outage).
    const allEps = await Promise.all(series.episodes.map(r => store.getEpisode(r.id)));
    series.reusable = allEps.every(e => e && e.status === 'complete'
      && e.segments.length > 0 && e.segments.every(s => s.status === 'ready'));
    await store.updateSeries(series);
    await store.addToLibrary({ type: 'deepdive', id: serId, title: t, createdAt: series.createdAt, userId: user.id });
  })();
});

/* ----- manifests (player polls these) ----------------------------------- */
app.get('/api/episode/:id/manifest', async (req, res) => {
  const user = await getReqUser(req);
  const ep = await store.getEpisode(req.params.id);
  if (!ep || (ep.userId && ep.userId !== user.id)) return res.status(404).json({ error: 'Not found' });
  res.json(ep);
});

app.get('/api/series/:id', async (req, res) => {
  const user = await getReqUser(req);
  const s = await store.getSeries(req.params.id);
  if (!s || (s.userId && s.userId !== user.id)) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

/* ----- library ---------------------------------------------------------- */
app.get('/api/library', async (req, res) => {
  const user = await getReqUser(req);
  res.json({ items: await store.getLibrary(user.id) });
});

/* ----- scheduling (Pro feature; stored now, pre-gen worker comes next) --- */
app.post('/api/schedule', async (req, res) => {
  const user = await getReqUser(req);
  if (TIER_RANK[user.tier] < TIER_RANK['pro'])
    return res.status(403).json({ error: 'feature_locked', message: 'Scheduled briefs are a Pro feature.' });
  const { config, times = ['07:00'], timezone = 'America/New_York' } = req.body || {};
  const hasTopics = config && Array.isArray(config.topics) && config.topics.length;
  const hasChannels = config && Array.isArray(config.channels) && config.channels.length;
  if (!hasTopics && !hasChannels)
    return res.status(400).json({ error: 'Schedule needs at least one topic or channel.' });
  const sId = id('sch');
  const sched = { id: sId, userId: user.id, config, times, timezone, createdAt: now() };
  await store.saveSchedule(sched);
  res.json(sched);
});
app.get('/api/schedule', async (req, res) => {
  const user = await getReqUser(req);
  const raw = await store.listSchedules(user.id);
  const schedules = raw.map(sc => ({
    id: sc.id,
    config: sc.config || {},
    times: sc.times || ['07:00'],
    timezone: sc.timezone || 'America/New_York',
    lastEpisodeId: sc.lastEpisodeId || null,
    lastGeneratedDate: sc.lastGeneratedDate || null,
    createdAt: sc.createdAt,
  }));
  res.json({ schedules });
});
app.delete('/api/schedule/:id', async (req, res) => {
  const user = await getReqUser(req);
  const ok = await store.deleteSchedule(req.params.id, user.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true, id: req.params.id });
});

// The app calls this on open to surface a pre-generated brief ("ready to play").
app.get('/api/today', async (req, res) => {
  const user = await getReqUser(req);
  const scheds = await store.listSchedules(user.id);
  let episodeId = null;
  for (const sc of scheds) {
    const today = localParts(sc.timezone).date;
    if (sc.lastGeneratedDate === today && sc.lastEpisodeId) episodeId = sc.lastEpisodeId;
  }
  if (!episodeId) return res.json({ ready: false });
  const ep = await store.getEpisode(episodeId);
  res.json({ ready: true, episodeId, status: ep ? ep.status : 'unknown' });
});

/* ----- fallback (serve a frontend if one exists) ------------------------ */
app.get(/^(?!\/api|\/audio).*$/, (req, res) => {
  const indexHtml = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res.json({ ok: true, service: 'MyCast backend v9', mock: MOCK_MODE });
});

const PORT = process.env.PORT || 3000;
/* ---- 6-hour pre-generation job for popular Rundown combos ---------------- */
const PRE_GEN_INTERVAL_MS = 6 * 3600 * 1000; // every 6 hours — keeps news fresh
const PRE_GEN_TOP_N = 15; // pre-generate the top N most-requested combos

async function preGeneratePopularCombos() {
  const combos = getPopularCombos(PRE_GEN_TOP_N);
  if (!combos.length) { console.log('pre-gen: no popular combos tracked yet'); return; }
  console.log('pre-gen: warming cache for', combos.length, 'popular combos');
  // Use the developer/system user so these don't count against any real
  // user's monthly generation limit.
  let sysUser = await store.getUser('system');
  if (!sysUser) sysUser = await store.createUser({ id: 'system', token: 'system', tier: 'pro', gen_count: 0, period_start: periodKey() });
  for (const combo of combos) {
    try {
      // Always regenerate on each pre-gen cycle so cached content reflects
      // the latest news rather than serving a stale 6-hour-old cache hit.
      console.log('pre-gen: generating', comboKey(combo.channels, combo.lengthMin), '(', combo.count, 'requests)');
      await buildBriefEpisode(sysUser, { channels: combo.channels, topics: [], window: '24h', lengthMin: combo.lengthMin, voiceId: 'josh' }, { await: true });
    } catch (e) {
      console.log('pre-gen failed for combo', comboKey(combo.channels, combo.lengthMin), ':', e.message);
    }
  }
  console.log('pre-gen: cycle complete');
}

if (require.main === module) {
  initDb()
    .catch(e => console.log('DB init error (continuing in-memory):', e.message))
    .finally(() => {
      app.listen(PORT, () =>
        console.log('MyCast v9.15 on port ' + PORT
          + (MOCK_MODE ? ' [MOCK_MODE: no API keys]' : '')
          + (USE_DB ? ' [Postgres]' : ' [in-memory]')));
      // scheduler: tick every minute, plus once shortly after boot
      setInterval(() => tickSchedules().catch(e => console.log('tick error:', e.message)), 60 * 1000);
      setTimeout(() => tickSchedules().catch(e => console.log('tick error:', e.message)), 5000);
      // popular-combo pre-generation: every 6 hours, plus once 2 min after boot
      // (delayed start so there's some real request data to base popularity on)
      setInterval(() => preGeneratePopularCombos().catch(e => console.log('pre-gen tick error:', e.message)), PRE_GEN_INTERVAL_MS);
      setTimeout(() => preGeneratePopularCombos().catch(e => console.log('pre-gen tick error:', e.message)), 2 * 60 * 1000);
    });
}

// Exported for testing only.
module.exports = { app, isFinanceTopic, dedupeSources, hostnameOf, retrieveForTopic, retrieveSources,
  tickSchedules, localParts, dueTimes, buildBriefEpisode, store,
  makeLimiter, fetchWithRetry, audioKey, synthesizeToFile, getSynthCount: () => synthCount, classifyTtsError, detectSportsTeam, sportsSourceForTopic };

/* =========================================================================
   PRODUCTION NOTES (not code — read before selling)
   1. PERSISTENCE: state is in-memory and audio is on ephemeral disk, so the
      Library is wiped on every redeploy/restart. For a real product, add a
      database (Railway Postgres → DATABASE_URL) for episode/series/library
      records, and object storage (Cloudflare R2 / S3) for segment audio.
   2. SCHEDULING: /api/schedule stores configs but nothing generates them
      yet. Add a cron worker (e.g. node-cron) that, ahead of each scheduled
      time per user timezone, runs the brief pipeline so it's ready on open.
   3. ACCOUNTS + LIMITS + BILLING: there is no auth here, so monthly limits
      and tier gating are advisory (client passes tier). Real enforcement
      needs user accounts + a billing provider (e.g. RevenueCat/Stripe).
   4. CONCURRENCY: generation runs in-process. Fine for early users; move
      heavy generation to a queue/worker when traffic grows.
   ========================================================================= */
