/* Free conversation transcription; no reference text or pronunciation inference. */
(function (G) {
  'use strict';
  function create({ client, capabilities = () => ({}), context, current = () => true, capture = G.CDG_SPEECH,
    Recognition = G.SpeechRecognition || G.webkitSpeechRecognition, onState = () => {}, onTranscript = () => {}, onError = () => {} }) {
    let epoch = 0, phase = 'idle', recording = null, recognition = null;
    const state = value => { phase = value; if (current()) onState(value); };
    const alive = n => n === epoch && current() && client?.enabled;
    function cancel() {
      epoch++; const old = recognition; recognition = null;
      try { old?.abort(); } catch (_) {}
      recording?.stop(true); recording = null; state('idle');
    }
    function browser() {
      if (!Recognition) { onError('browser_unavailable'); return; }
      const n = ++epoch; let final = '';
      try {
        const r = recognition = new Recognition(); r.lang = 'zh-CN'; r.interimResults = false; r.maxAlternatives = 1;
        r.onresult = e => { if (!alive(n)) return; final = [...e.results].filter(x => x.isFinal).map(x => x[0].transcript).join(''); };
        r.onerror = () => { if (alive(n)) { recognition = null; epoch++; state('idle'); onError('browser_failed'); } };
        r.onend = () => { if (n !== epoch) return; recognition = null; state('idle'); if (alive(n) && final.trim()) onTranscript(final.trim(), 'browser_asr'); };
        state('browser'); r.start();
      } catch (_) { recognition = null; state('idle'); onError('browser_failed'); }
    }
    async function toggle() {
      if (!client?.enabled || !current()) { onError('offline'); return; }
      if (phase === 'browser') { try { recognition?.stop(); } catch (_) { cancel(); onError('browser_failed'); } return; }
      if (['permission', 'sending'].includes(phase)) return;
      if (recording) {
        const n = epoch, voice = recording; recording = null; const blob = voice.stop();
        if (!blob) { state('idle'); onError('empty_audio'); return; }
        state('sending');
        try {
          const form = new FormData(); form.append('audio', blob, 'question.wav');
          for (const [k,v] of Object.entries({ ...context(), sessionId: client.sessionId, mode: 'open', refText: '' })) form.set(k, String(v));
          const result = await client.request('/api/speech/assess', form, 16000);
          if (!alive(n)) return;
          if (!result.ok || result.transcriptSource !== 'recognition' || !String(result.transcript || '').trim()) throw new Error('no_transcript');
          onTranscript(String(result.transcript).slice(0, 500), 'cloud_asr');
        } catch (_) { if (alive(n)) { state('idle'); onError('cloud_failed'); browser(); } }
        finally { if (n === epoch && phase !== 'browser') state('idle'); }
        return;
      }
      if (!capabilities().asr) { browser(); return; }
      const n = ++epoch; state('permission');
      try {
        const voice = await capture.start({ onLimit: () => { if (alive(n)) void toggle(); } });
        if (!alive(n)) { voice.stop(true); return; }
        recording = voice; state('recording');
      } catch (_) { if (alive(n)) { state('idle'); onError('microphone_denied'); } }
    }
    return { toggle, cancel, get phase() { return phase; } };
  }
  G.CDG_NPC_VOICE = { create };
  if (typeof module !== 'undefined') module.exports = G.CDG_NPC_VOICE;
})(typeof window !== 'undefined' ? window : globalThis);
