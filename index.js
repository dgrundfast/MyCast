const express = require('express');
const cors = require('cors');
const path = require('path');
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/voices', (req, res) => {
  res.json(Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name, desc: v.name })));
});

app.post('/api/generate', async (req, res) => {
  const { topic, episodeLength } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  const mins = episodeLength === 'ai' ? 10 : parseInt(episodeLength);
  const prompt = `You are MyCast. User wants to learn: "${topic}". Create a 5-episode podcast series. Return ONLY valid JSON with no markdown and no code fences: {"series_title":"","series_subtitle":"","episodes":[{"episode_number":1,"title":"","duration_minutes":${mins},"teaser":"","script":"full engaging educational script here"}]}. Make all 5 episodes with rich detailed scripts.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16000,
    const d = await r.json();
    if (!d.content || !d.content[0]) {
      return res.status(500).json({ error: 'AI error: ' + JSON.stringify(d) });
    }
    const text = d.content[0].text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/synthesize', async (req, res) => {
  const { text, voiceKey } = req.body;
  const voice = VOICES[voiceKey] || VOICES.alex;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': EK },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    const buf = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get(/^(?!\/api).*$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MyCast on port ' + PORT));
