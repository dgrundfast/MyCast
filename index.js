const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const AK = process.env.ANTHROPIC_API_KEY;
const EK = process.env.ELEVENLABS_API_KEY;
const VOICES = {
  alex:   { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
  james:  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold' },
  maya:   { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
  sophie: { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli' },
  roger:  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  brian:  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian' },
};

// In-memory cache for briefings
const briefingCache = {};

// In-memory schedule store (upgrade to database later)
const scheduleStore = {};

app.get('/api/health', (req, res) => res.json({ ok: true }));

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

app.post('/api/schedule', (req, res) => {
  const { enabled, time, channelIds } = req.body;
  if (enabled === undefined || !time || !channelIds) return res.status(400).json({ error: 'Missing required fields' });
  const sortedChannelIds = channelIds.slice().sort();
  const scheduleKey = sortedChannelIds.join('+');
  if (enabled) {
    scheduleStore[scheduleKey] = { enabled: true, time, channelIds: sortedChannelIds, updatedAt: new Date().toISOString() };
    console.log('Schedule saved:', scheduleKey, 'at', time);
  } else {
    delete scheduleStore[scheduleKey];
    console.log('Schedule removed:', scheduleKey);
  }
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

  if (briefingCache[cacheKey]) {
    console.log('Cache hit:', cacheKey);
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
    '{"title":"Morning Briefing — ' + dateLabel + '","subtitle":"' + dateLabel + '","teaser":"One sentence summary of top stories.","script":"The full spoken script here — ' + wordLimit + ' words or less.","sources":["Reuters","Associated Press","BBC News"]}' +
    ' For sources, list the real news outlets that cover these topics (e.g. Reuters, Associated Press, BBC News, Bloomberg, ESPN). List one per topic or channel covered.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!d.content || !d.content[0]) return res.status(500).json({ error: 'AI error: ' + JSON.stringify(d) });
