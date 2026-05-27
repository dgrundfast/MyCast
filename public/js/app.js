const App = (() => {
  let episodes = [], cur = 0, playing = false, ticker = null;
  let secs = 0, total = 0, seriesData = null;
  let selectedVoiceKey = 'alex';
  let audioEl = null;
  let audioCache = {};
  let voices = [];
  let stepTimer = null;

  const fmt = s => Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  const $ = id => document.getElementById(id);

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function showError(msg) { const el=$('setup-error'); el.textContent=msg; el.style.display='block'; }
  function hideError() { $('setup-error').style.display='none'; }

  async function loadVoices() {
    try {
      const res = await fetch('/api/voices');
      voices = await res.json();
      const group = $('voice-radio-group');
      group.innerHTML = '';
      voices.forEach((v, i) => {
        const lbl = document.createElement('label');
        lbl.className = 'radio-item';
        lbl.innerHTML = `<input type="radio" name="voice" value="${v.key}" ${i===0?'checked':''}><span class="rc"></span><span class="rt"><strong>${v.name}</strong> ${v.desc}</span>`;
        group.appendChild(lbl);
      });
      if (voices.length) selectedVoiceKey = voices[0].key;
    } catch(e) { console.error('Failed to load voices', e); }
  }

  function startSteps() {
    ['step-1','step-2','step-3','step-4'].forEach(id => { const el=$(id); el.classList.remove('active','done'); });
    $('step-1').classList.add('active');
    let i = 1;
    stepTimer = setInterval(() => {
      if (i < 4) {
        $(`step-${i}`).classList.remove('active'); $(`step-${i}`).classList.add('done');
        $(`step-${i+1}`).classList.add('active'); i++;
      }
    }, 7000);
  }

  function stopSteps() {
    clearInterval(stepTimer);
    ['step-1','step-2','step-3','step-4'].forEach(id => { const el=$(id); el.classList.remove('active'); el.classList.add('done'); });
  }

  async function generate() {
    hideError();
    const topic = $('topic').value.trim();
    const episodeLength = document.querySelector('input[name="length"]:checked')?.value || '10';
    const voiceInput = document.querySelector('input[name="voice"]:checked');
    selectedVoiceKey = voiceInput?.value || (voices[0]?.key || 'alex');
    if (!topic) { showError('Please enter a topic you want to learn.'); return; }
    $('btn-generate').disabled = true;
    audioCache = {};
    show('screen-loading');
    startSteps();
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, episodeLength }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Server error'); }
      const data = await res.json();
      stopSteps();
      loadCast(data);
    } catch(err) {
      stopSteps(); show('screen-setup');
      $('btn-generate').disabled = false;
      showError('Error: ' + err.message);
    }
  }

  function loadCast(data) {
    seriesData = data; episodes = data.episodes;
    $('series-title').textContent = data.series_title;
    $('series-sub').textContent = data.series_subtitle;
    $('ep-count').textContent = episodes.length + ' episodes';
    const voiceObj = voices.find(v => v.key === selectedVoiceKey);
    $('voice-name-display').textContent = voiceObj ? voiceObj.name : selectedVoiceKey;
    buildWave(); buildList(); loadEp(0);
    show('screen-player');
  }

  function buildWave() {
    const wf = $('waveform'); wf.innerHTML = '';
    for (let i = 0; i < 58; i++) {
      const h = Math.random()*26+6;
      const b = document.createElement('div');
      b.className = 'wbar'; b.style.height = h+'px'; wf.appendChild(b);
    }
  }

  function animWave(on) {
    document.querySelectorAll('.wbar').forEach((b,i) => {
      if (on) {
        b.style.animation = `wbar ${(0.4+Math.random()*0.6).toFixed(2)}s ease-in-out ${(i*0.02).toFixed(3)}s infinite`;
        b.style.background = 'var(--amber)'; b.style.opacity = (0.4+Math.random()*0.4).toFixed(2);
      } else {
        b.style.animation = 'none'; b.style.background = 'var(--bg4)'; b.style.opacity = '1';
      }
    });
  }

  function buildList() {
    const list = $('episode-list'); list.innerHTML = '';
    episodes.forEach((ep, i) => {
      const row = document.createElement('div');
      row.className = 'ep-row'; row.id = 'row'+i;
      row.innerHTML = `<div class="ep-num">${i+1}</div><div class="ep-info"><div class="ep-title">${ep.title}</div><div class="ep-dur">${ep.duration_minutes} min</div></div>`;
      row.addEventListener('click', () => { stopAudio(); loadEp(i); });
      list.appendChild(row);
    });
  }

  function hilite(i) {
    document.querySelectorAll('.ep-row').forEach((r,j) => r.classList.toggle('active', j===i));
    const row = $('row'+i);
    if (row) row.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }

  function loadEp(i) {
    cur = i; const ep = episodes[i];
    $('np-title').textContent = ep.title;
    $('np-meta').textContent = `Episode ${ep.episode_number} · ${ep.duration_minutes} min`;
    $('np-teaser').textContent = ep.teaser || '';
    total = ep.duration_minutes * 60; secs = 0;
    $('t-tot').textContent = fmt(total);
    $('t-cur').textContent = '0:00';
    $('pfill').style.width = '0%';
    hilite(i);
    $('btn-prev').disabled = i===0;
    $('btn-next').disabled = i===episodes.length-1;
  }

  async function synthesizeEp(i) {
    if (audioCache[i]) return audioCache[i];
    const ep = episodes[i];
    showSynthStatus(`Generating audio for Episode ${i+1}…`);
    const res = await fetch('/api/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ep.script, voiceKey: selectedVoiceKey }),
    });
    if (!res.ok) throw new Error('Voice synthesis failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audioCache[i] = url;
    hideSynthStatus();
    return url;
  }

  function showSynthStatus(msg) { $('synth-status').style.display='flex'; $('synth-msg').textContent=msg; }
  function hideSynthStatus() { $('synth-status').style.display='none'; }

  function togglePlay() { playing ? pauseAudio() : playAudio(); }

  async function playAudio() {
    try {
      const url = await synthesizeEp(cur);
      stopAudio();
      audioEl = new Audio(url);
      audioEl.playbackRate = parseFloat($('speed').value);
      audioEl.addEventListener('timeupdate', () => {
        secs = Math.floor(audioEl.currentTime);
        total = Math.floor(audioEl.duration) || total;
        $('t-cur').textContent = fmt(secs);
        $('t-tot').textContent = fmt(total);
        $('pfill').style.width = (audioEl.duration ? (audioEl.currentTime/audioEl.duration*100) : 0) + '%';
      });
      audioEl.addEventListener('ended', () => {
        if (cur < episodes.length-1) { stopAudio(); loadEp(cur+1); playAudio(); } else stopAudio();
      });
      await audioEl.play();
      playing = true;
      $('play-icon').className = 'ti ti-player-pause';
      animWave(true);
      if (cur+1 < episodes.length && !audioCache[cur+1]) {
        setTimeout(() => synthesizeEp(cur+1).catch(()=>{}), 3000);
      }
    } catch(err) {
      hideSynthStatus();
      alert('Audio generation failed: ' + err.message);
    }
  }

  function pauseAudio() {
    if (audioEl) audioEl.pause();
    playing = false;
    $('play-icon').className = 'ti ti-player-play';
    animWave(false);
  }

  function stopAudio() {
    if (audioEl) { audioEl.pause(); audioEl.src=''; audioEl=null; }
    playing = false;
    $('play-icon').className = 'ti ti-player-play';
    animWave(false);
  }

  function prevEp() { if(cur>0){ stopAudio(); loadEp(cur-1); } }
  function nextEp() { if(cur<episodes.length-1){ stopAudio(); loadEp(cur+1); } }
  function changeSpeed() { if(audioEl) audioEl.playbackRate = parseFloat($('speed').value); }

  function seek(e) {
    const bar = $('pbar');
    const pct = Math.max(0, Math.min(1, e.offsetX/bar.offsetWidth));
    if (audioEl && audioEl.duration) audioEl.currentTime = pct * audioEl.duration;
    else { secs=Math.round(pct*total); $('pfill').style.width=Math.round(pct*100)+'%'; $('t-cur').textContent=fmt(secs); }
  }

  function shareCast() {
    if (!seriesData) return;
    const title = seriesData.series_title;
    const text = `🎙 Check out my MyCast: "${title}" — ${seriesData.series_subtitle}\n\nGenerated with MyCast — personal AI podcast generator.`;
    if (navigator.share) navigator.share({ title, text });
    else navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
  }

  function goSetup() { stopAudio(); $('btn-generate').disabled=false; show('screen-setup'); }

  document.addEventListener('DOMContentLoaded', () => {
    loadVoices();
    $('topic').addEventListener('keydown', e => { if(e.key==='Enter') generate(); });
  });

  return { generate, goSetup, togglePlay, prevEp, nextEp, changeSpeed, seek, shareCast };
})();
