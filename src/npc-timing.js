// Bounded page-memory diagnostics. No questions, answers, audio, names or session IDs.
(function (G) {
  'use strict';
  function create({ clock = () => G.performance.now(), capacity = 100 } = {}) {
    const rows = []; let serial = 0;
    const limit = Math.min(500, Math.max(1, Math.floor(capacity) || 100));
    function begin({ kind, role, submittedAt } = {}) {
      const at = clock(), start = Number.isFinite(submittedAt) && submittedAt >= 0 && submittedAt <= at ? submittedAt : at;
      const row = { id: ++serial, kind: kind === 'feedback' ? 'feedback' : 'question', role: role === 'dragon' ? 'dragon' : 'wang',
        status: 'pending', source: null, responseReceivedMs: null, serverMs: null, answerFrameMs: null,
        cueRequestedMs: null, cueSpeechStartMs: null, cueSpeechResult: null, answerSpeechStartMs: null, answerSpeechResult: null,
        cancelledMs: null, cancelReason: null, modelFirstTokenMs: null, streaming: false };
      rows.push(row); if (rows.length > limit) rows.shift();
      const elapsed = () => { const value = clock() - start; return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null; };
      const mutable = () => row.status !== 'cancelled';
      const speechResult = value => ['ended','end_without_start','disabled','unavailable','no_voice','empty_text','error','start_timeout','playback_timeout','cancelled','superseded'].includes(value) ? value : 'unknown';
      return {
        cueRequested() { if (row.status === 'pending' && row.cueRequestedMs === null) row.cueRequestedMs = elapsed(); },
        speechStarted(which) { const key = which === 'cue' ? 'cueSpeechStartMs' : 'answerSpeechStartMs'; if (mutable() && row[key] === null) row[key] = elapsed(); },
        speechFinished(which, result) { row[which === 'cue' ? 'cueSpeechResult' : 'answerSpeechResult'] = speechResult(result?.reason); },
        received(result) {
          if (!mutable() || row.status !== 'pending') return;
          row.status = 'received'; row.responseReceivedMs = elapsed();
          row.source = ['llm','script'].includes(result?.source) ? result.source : 'unknown';
          row.serverMs = Number.isFinite(result?.latencyMs) && result.latencyMs >= 0 && result.latencyMs <= 60000 ? result.latencyMs : null;
        },
        frame() { if (row.status === 'received') { row.status = 'rendered'; row.answerFrameMs = elapsed(); } },
        cancel(reason) {
          if (row.status === 'rendered' || row.status === 'cancelled') return;
          row.status = 'cancelled'; row.cancelledMs = elapsed();
          row.cancelReason = ['superseded','dialog_closed','offline','new_prompt','recording','stale'].includes(reason) ? reason : 'cancelled';
        },
      };
    }
    return { begin, snapshot: () => rows.map(row => ({ ...row })), clear: () => { rows.length = 0; } };
  }
  G.CDG_NPC_TIMING = { create };
  if (typeof module !== 'undefined') module.exports = G.CDG_NPC_TIMING;
})(typeof window !== 'undefined' ? window : globalThis);
