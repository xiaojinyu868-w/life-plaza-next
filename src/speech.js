/* Record in memory. No audio storage or browser-to-vendor credentials. */
(function (G) {
  'use strict';
  function wav16k(samples, inputRate) {
    if (!(samples instanceof Float32Array) || !Number.isFinite(inputRate) || inputRate < 8000) throw new Error('invalid_audio');
    const count = Math.floor(samples.length * 16000 / inputRate);
    const buf = new ArrayBuffer(44 + count * 2), v = new DataView(buf);
    const txt = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
    txt(0, 'RIFF'); v.setUint32(4, 36 + count * 2, true); txt(8, 'WAVE'); txt(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    txt(36, 'data'); v.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * inputRate / 16000), end = Math.max(start + 1, Math.floor((i + 1) * inputRate / 16000));
      let s = 0; for (let j = start; j < end && j < samples.length; j++) s += samples[j];
      s = Math.max(-1, Math.min(1, s / (end - start))); v.setInt16(44 + i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true);
    }
    return buf;
  }
  async function start({ onLimit, maxSeconds = 20 } = {}) {
    if (!G.navigator?.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable');
    const stream = await G.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    let ctx, source, proc, timer, stopped = false, chunks = [];
    function clean() { clearTimeout(timer); if (proc) { proc.onaudioprocess = null; proc.disconnect(); } source?.disconnect(); stream.getTracks().forEach(t => t.stop()); if (ctx) ctx.close().catch(() => {}); }
    try {
      ctx = new (G.AudioContext || G.webkitAudioContext)();
      await ctx.resume(); source = ctx.createMediaStreamSource(stream); proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = e => { if (!stopped) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(proc); proc.connect(ctx.destination);
      const stop = (discard = false) => {
        if (stopped) return null; stopped = true; clean();
        const length = chunks.reduce((n, c) => n + c.length, 0);
        if (discard || !length) { chunks = []; return null; }
        const all = new Float32Array(length); let i = 0; for (const c of chunks) { all.set(c, i); i += c.length; } chunks = [];
        const blob = new Blob([wav16k(all, ctx.sampleRate)], { type: 'audio/wav' }); all.fill(0); return blob;
      };
      timer = setTimeout(() => onLimit?.(), maxSeconds * 1000);
      return { stop };
    } catch (e) { clean(); throw e; }
  }
  G.CDG_SPEECH = { wav16k, start };
  if (typeof module !== 'undefined') module.exports = G.CDG_SPEECH;
})(typeof window !== 'undefined' ? window : globalThis);
