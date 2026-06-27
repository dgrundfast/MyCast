const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AK = process.env.ANTHROPIC_API_KEY;
const EK = process.env.ELEVENLABS_API_KEY;
const RC_SECRET = process.env.REVENUECAT_SECRET_KEY;

const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function initDb() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'free',
        schedule_enabled BOOLEAN DEFAULT false,
        schedule_time TEXT,
        schedule_channel_ids TEXT[],
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS briefing_cache (
        cache_key TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    console.log('Database initialized');
  } catch (e) {
    console.error('Database init error:', e.message);
  }
}

const VOICES = {
  alex:   { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
  james:  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold' },
  maya:   { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
  sophie: { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli' },
  roger:  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  brian:  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian' },
};

const briefingCache = {};

app.get('/api/health', async (req, res) => {
  const dbOk = db ? await db.query('SELECT 1').then(() => true).catch(() => false) : false;
  res.json({ ok: true, db: dbOk });
});

app.get('/api/voices', (req, res) => {
  res.json(Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name, desc: v.name })));
});

app.get('/api/channels', (req, res) => {
  res.json([
    { id: 'world',         name: 'World News',           symbol: 'globe',                      color: '#4F9CF0' },
    { id: 'politics',      name: 'US Politics',           symbol: 'building.columns.fill',      color: '#D06B6B' },
    { id: 'technology',    name: 'Technology',            symbol: 'cpu',                        color: '#7C8CF8' },
    { id: 'markets',       name: 'Markets & Finance',     symbol: 'chart.line.uptrend.xyaxis',  color: '#4FCB8B' },
    { id: 'science',       name: 'Science',               symbol: 'atom',                       color: '#F0A04F' },
    { id: 'health',        name: 'Health',                symbol: 'heart.fill',                 color: '#F06F8C' },
    { id: 'sports',        name: 'Sports',                symbol: 'sportscourt.fill',           color: '#4FC8F0' },
    { id: 'entertainment', name: 'Entertainment',         symbol: 'star.fill',                  color: '#C87CF8' },
    { id: 'climate',       name: 'Climate & Environment', symbol: 'leaf.fill',                  color: '#4FCB8B' },
    { id: 'business',      name: 'Business',              symbol: 'briefcase.fill',             color: '#F0C44F' },
  ]);
});

app.post('/api/billing/refresh', async (req, res) => {
  const { userId, appUserId } = req.body;
  const rcUserId = appUserId || userId;
  if (!rcUserId) return res.status(400).json({ error: 'userId required' });
  try {
    let tier = 'free';
    if (RC_SECRET) {
      const rcRes = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(rcUserId), {
        headers: { 'Authorization': 'Bearer ' + RC_SECRET, 'Content-Type': 'application/json' },
      });
      if (rcRes.ok) {
        const rcData = await rcRes.json();
        const entitlements = rcData.subscriber?.entitlements || {};
        if (entitlements['pro'] && entitlements['pro'].expires_date > new Date().toISOString()) {
          tier = 'pro';
        } else if (entitlements['plus'] && entitlements['plus'].expires_date > new Date().toISOString()) {
          tier = 'plus';
        }
      }
    }
    if (db) {
      await db.query(
        'INSERT INTO users (id, tier, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET tier = $2, updated_at = NOW()',
        [rcUserId, tier]
      );
    }
    console.log('Billing refresh:', rcUserId, '->', tier);
    res.json({ userId: rcUserId, tier });
  } catch (e) {
    console.error('Billing refresh error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/schedule', async (req, res) => {
  const { userId, enabled, time, channelIds } = req.body;
  if (enabled === undefined || !time || !channelIds) return res.status(400).json({ error: 'Missing required fields' });
  const sortedChannelIds = channelIds.slice().sort();
  if (db) {
    try {
      await db.query(
        'INSERT INTO users (id, schedule_enabled, schedule_time, schedule_channel_ids, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (id) DO UPDATE SET schedule_enabled = $2, schedule_time = $3, schedule_channel_ids = $4, updated_at = NOW()',
        [userId || 'default', enabled, time, sortedChannelIds]
      );
    } catch (e) {
      console.error('Schedule save error:', e.message);
    }
  }
  console.log('Schedule', enabled ? 'saved' : 'removed', 'at', time);
  res.status(200).json({});
});

app.post('/api/briefing', async (req, res) => {
  const { channels, channelIds, topics, episodeLength, maxWords, date, timestamp, timezone } = req.body;
  const mins = episodeLength || 5;
  const wordLimit = maxWords || 400;
  const briefingDate = date || new Date().toISOString().split('T')[0];
  const briefingTimestamp = timestamp || new Date().toISOString();
  const sortedTopics = (topics || []).slice().sort();
  const topicsHash = crypto.createHash('sha1').update(sortedTopics.join('|')).digest('hex').slice(0, 8);
  const sortedChannelIds = (channelIds || []).slice().sort();
  const cacheKey = sortedChannelIds.join('+') + '_' + briefingDate + '_' + mins + '_' + topicsHash;

  if (db) {
    try {
      const cached = await db.query('SELECT data FROM briefing_cache WHERE cache_key = $1 AND expires_at > NOW()', [cacheKey]);
      if (cached.rows.length > 0) {
        console.log('DB cache hit:', cacheKey);
        return res.json(cached.rows[0].data);
      }
    } catch (e) {
      console.error('Cache read error:', e.message);
    }
  } else if (briefingCache[cacheKey]) {
    console.log('Memory cache hit:', cacheKey);
    return res.json(briefingCache[cacheKey]);
  }

  const channelList = (channels || []).join(', ');
  const topicList = sortedTopics.length ? sortedTopics.join(', ') : null;
  const dateLabel = new Date(briefingTimestamp).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = 'You are a professional news anchor delivering a morning briefing podcast. ' +
    'Today is ' + dateLabel + ' (' + briefingTimestamp + '). ' +
    'Write a morning briefing script covering these topic channels: ' + channelList + '.' +
    (topicList ? ' Also specifically cover these focus areas: ' + topicList + '.' : '') +
    ' The script must be ' + wordLimit + ' words or less. ' +
    'Write in a natural, conversational podcast style — punchy, clear, and engaging. ' +
    'Start with "Good morning." and cover the most important developments across each area. ' +
    'Return ONLY a raw JSON object with no markdown, no code fences, and no explanation. Use this exact structure: ' +
    '{"title":"Morning Briefing — ' + dateLabel + '","subtitle":"' + dateLabel + '","teaser":"One sentence summary of top stories.","script":"The full spoken script here.","sources":["Reuters","Associated Press","BBC News"]}' +
    ' For sources, list the real news outlets that cover these topics. List one per topic or channel covered.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!d.content || !d.content[0]) return res.status(500).json({ error: 'AI error: ' + JSON.stringify(d) });
    let text = d.content[0].text.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON found', raw: text.slice(0, 200) });
    text = text.slice(start, end + 1);
    const parsed = JSON.parse(text);
    if (db) {
      try {
        const midnight = new Date(briefingDate + 'T23:59:59Z');
        await db.query(
          'INSERT INTO briefing_cache (cache_key, data, expires_at) VALUES ($1, $2, $3) ON CONFLICT (cache_key) DO UPDATE SET data = $2, expires_at = $3',
          [cacheKey, JSON.stringify(parsed), midnight.toISOString()]
        );
      } catch (e) {
        console.error('Cache write error:', e.message);
      }
    } else {
      briefingCache[cacheKey] = parsed;
    }
    console.log('Cache set:', cacheKey);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/generate', async (req, res) => {
  const { topic, episodeLength } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  const mins = episodeLength === 'ai' ? 5 : parseInt(episodeLength);
  const wordsPerMinute = 150;
  const targetWords = mins * wordsPerMinute;
  const prompt = 'Create a 3-episode podcast series about "' + topic + '". Each episode script should be approximately ' + targetWords + ' words long to fill ' + mins + ' minutes of audio. Return ONLY a raw JSON object with no markdown, no code fences, and no explanation. Use this exact structure: {"series_title":"short catchy title","series_subtitle":"one sentence description","episodes":[{"episode_number":1,"title":"episode title","duration_minutes":' + mins + ',"teaser":"one sentence hook","script":"Full ' + targetWords + '-word podcast script here."},{"episode_number":2,"title":"episode title","duration_minutes":' + mins + ',"teaser":"one sentence hook","script":"Full ' + targetWords + '-word podcast script here."},{"episode_number":3,"title":"episode title","duration_minutes":' + mins + ',"teaser":"one sentence hook","script":"Full ' + targetWords + '-word podcast script here."}]}';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!d.content || !d.content[0]) return res.status(500).json({ error: 'AI error: ' + JSON.stringify(d) });
    let text = d.content[0].text.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON found', raw: text.slice(0, 200) });
    text = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.episodes || parsed.episodes.length < 3) return res.status(500).json({ error: 'Incomplete response', raw: text.slice(0, 200) });
      res.json(parsed);
    } catch (parseErr) {
      res.status(500).json({ error: 'JSON parse failed: ' + parseErr.message, raw: text.slice(0, 300) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/synthesize', async (req, res) => {
  const { text, voiceKey } = req.body;
  const voice = VOICES[voiceKey] || VOICES.alex;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': EK },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    console.log('ElevenLabs status:', r.status);
    if (!r.ok) {
      const errText = await r.text();
      console.log('ElevenLabs error:', errText);
      return res.status(500).json({ error: 'ElevenLabs error: ' + errText });
    }
    const buf = await r.arrayBuffer();
    console.log('Audio buffer size:', buf.byteLength);
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    console.log('Synthesize exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get(/^(?!\/api).*$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log('MyCast v9 on port ' + PORT));
});

    

