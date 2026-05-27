const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

const VOICES = {
  'alex':   { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',   desc: 'Warm, American male' },
  'james':  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', desc: 'Deep, authoritative' },
  'maya':   { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',  desc: 'Clear, American female' },
  'sophie': { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli',   desc: 'Warm, energetic female' },
  'roger':  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger',  desc: 'Laid-back, casual' },
  'brian':  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian',  desc: 'Professional narrator' },
};

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/voices', (req, res) => {
  const list = Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name, desc: v.desc }));
  res.json(list);
});

app.post('/api/generate', async (req, res) => {
  const { topic, episodeLength } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });
  const lenLabel = episodeLength === 'ai' ? 'whatever length best fits each topic' : `${episodeLength} minutes per episode`;
  const prompt = `You are MyCast, an expert curriculum designer and podcast host. The user wants to learn: "${topic}". Design a structured personal podcast series teaching this from beginner to advanced. Return ONLY valid JSON — no markdown, no fences, nothing else. Each episode: ${lenLabel} of listening. { "series_title": "punchy memorable title", "series_subtitle": "one sentence on what the listener achieves", "episodes": [ { "episode_number": 1, "title": "episode title", "duration_minutes": 10, "teaser": "one engaging sentence", "script": "Full spoken podcast script. Warm, conversational, genuinely educational. No stage directions. Include a hook, real content with examples, preview of next episode." } ] } Generate 5 episodes with rich, substantive scripts.`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) { const err = await response.json(); return res.status(response.status).json({ error: err.error?.message || 'Anthropic error' }); }
    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('');
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/synthesize', async (req, res) => {
  const { text, voiceKey } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });
  const voice = VOICES[voiceKey] || VOICES['alex'];
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_KEY },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } }),
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Voice synthesis failed' });
    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙 MyCast running at http://localhost:${PORT}`));
