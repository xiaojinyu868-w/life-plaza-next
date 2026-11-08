/* Browser-reported speech lifecycle; no text persistence or voice discovery. */
(function (G) {
  'use strict';
  function create({ synthesis = G.speechSynthesis, Utterance = G.SpeechSynthesisUtterance,
    voice = () => null, enabled = () => true,
    setTimer = (fn, ms) => G.setTimeout(fn, ms), clearTimer = id => G.clearTimeout(id) } = {}) {
    let active = null;
    const safely = fn => { try { fn(); } catch (_) {} };
    function play(text, role, { onStart, onEnd } = {}) {
      if (active) active.finish('superseded', true);
      let resolve, utterance = null, started = false, ended = false, done = false, submitted = false;
      let startTimer, endTimer;
      const finished = new Promise(r => { resolve = r; });
      const state = { finish };
      const handle = { finished, cancel: () => finish('cancelled', true) };
      active = state;
      function finish(reason, cancel = false) {
        if (done || active !== state) return;
        done = true;
        active = null;
        if (startTimer !== undefined) safely(() => clearTimer(startTimer));
        if (endTimer !== undefined) safely(() => clearTimer(endTimer));
        if (utterance) {
          utterance.onstart = utterance.onend = utterance.onerror = null;
          utterance = null;
        }
        // cancel() affects the synthesis queue: callers must centralize speech here.
        if (cancel && submitted) safely(() => synthesis.cancel());
        const result = Object.freeze({ started, ended, reason });
        resolve(result);
        if (ended && typeof onEnd === 'function') safely(() => onEnd(result));
        onStart = onEnd = null;
      }
      try {
        if (!enabled()) { finish('disabled'); return handle; }
        if (!synthesis || typeof synthesis.speak !== 'function' || typeof synthesis.cancel !== 'function'
          || typeof Utterance !== 'function') { finish('unavailable'); return handle; }
        if (typeof text !== 'string' || !text.trim()) { finish('empty_text'); return handle; }
        const selected = voice();
        if (!selected) { finish('no_voice'); return handle; }
        utterance = new Utterance(text);
        utterance.voice = selected;
        utterance.lang = selected.lang || 'zh-CN';
        utterance.rate = role === 'dragon' ? 1 : 0.88;
        utterance.pitch = role === 'dragon' ? 1.5 : 0.95;
        utterance.volume = 1;
        utterance.onstart = () => {
          if (done || active !== state || started) return;
          started = true;
          safely(() => clearTimer(startTimer));
          startTimer = undefined;
          if (typeof onStart === 'function') safely(() => onStart());
        };
        utterance.onend = () => {
          if (done || active !== state) return;
          ended = true;
          finish(started ? 'ended' : 'end_without_start');
        };
        utterance.onerror = () => finish('error', true);
        startTimer = setTimer(() => { if (!started) finish('start_timeout', true); }, 1200);
        endTimer = setTimer(() => finish('playback_timeout', true), Math.min(60000, 2500 + text.length * 450));
        submitted = true;
        synthesis.speak(utterance);
      } catch (_) { finish('error', true); }
      return handle;
    }
    return { play, stop() { if (active) active.finish('cancelled', true); } };
  }
  G.CDG_VOICE_OUTPUT = { create };
  if (typeof module !== 'undefined') module.exports = G.CDG_VOICE_OUTPUT;
})(typeof window !== 'undefined' ? window : globalThis);
