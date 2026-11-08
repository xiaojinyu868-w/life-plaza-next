const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/npc-voice.js');
const turn = { lesson: 'nev-l4', station: 'c', step: 'question-1' };
function setup(overrides = {}) {
  const transcripts = [], errors = [], stops = [], states = [], requests = [];
  const client = { enabled: true, sessionId: 's_voice_test_12345678', request: async (url, form) => { requests.push({ url, form }); return { ok: true, transcript: '这是发动机吗？', transcriptSource: 'recognition' }; } };
  const voice = create({ client, capabilities: () => ({ asr: true }), context: () => turn,
    capture: { start: async () => ({ stop(discard) { stops.push(!!discard); return discard ? null : new Blob(['synthetic'], { type: 'audio/wav' }); } }) },
    onTranscript: (...x) => transcripts.push(x), onError: x => errors.push(x), onState: x => states.push(x), ...overrides });
  return { voice, client, transcripts, errors, stops, states, requests };
}
test('NPC microphone transcribes open speech without reference and never sends to the NPC model automatically', async () => {
  const t = setup(); await t.voice.toggle(); assert.equal(t.voice.phase, 'recording'); await t.voice.toggle();
  assert.equal(t.requests.length, 1); const req = t.requests[0]; assert.equal(req.url, '/api/speech/assess');
  assert.equal(req.form.get('mode'), 'open'); assert.equal(req.form.get('refText'), ''); assert.equal(req.form.get('lesson'), turn.lesson);
  assert.deepEqual(t.transcripts, [['这是发动机吗？', 'cloud_asr']]); assert.equal(t.voice.phase, 'idle');
});
test('closing a recording discards audio without sending a request', async () => {
  const t = setup(); await t.voice.toggle(); t.voice.cancel(); assert.deepEqual(t.stops, [true]); assert.equal(t.requests.length, 0);
});
test('permission resolved after cancellation releases the microphone', async () => {
  let release, discarded = false;
  const t = setup({ capture: { start: () => new Promise(resolve => { release = resolve; }) } });
  const pending = t.voice.toggle(); t.voice.cancel(); release({ stop(discard) { discarded = discard; } }); await pending;
  assert.equal(discarded, true); assert.equal(t.voice.phase, 'idle'); assert.equal(t.requests.length, 0);
});
test('reply after close, changed context, or offline cannot fill the question', async () => {
  for (const reason of ['cancel','stale','offline']) {
    let release, current = true; const t = setup({ current: () => current });
    t.client.request = () => new Promise(resolve => { release = resolve; });
    await t.voice.toggle(); const pending = t.voice.toggle();
    if (reason === 'cancel') t.voice.cancel(); if (reason === 'stale') current = false; if (reason === 'offline') t.client.enabled = false;
    release({ ok: true, transcript: '假装正确', transcriptSource: 'recognition' }); await pending;
    assert.deepEqual(t.transcripts, []);
  }
});
test('aligned reference cannot be used as NPC ASR; unavailable browser remains a recoverable error', async () => {
  const t = setup({ Recognition: null });
  t.client.request = async () => ({ ok: true, transcript: '参考文本', transcriptSource: 'none' });
  await t.voice.toggle(); await t.voice.toggle(); assert.deepEqual(t.transcripts, []);
  assert.deepEqual(t.errors, ['cloud_failed','browser_unavailable']); assert.equal(t.voice.phase, 'idle');
});
test('browser recognition fallback returns text only and abort prevents delayed final transcript', async () => {
  let instance;
  class Recognition { constructor() { instance = this; } start() {} stop() { this.onend(); } abort() { this.onend(); } }
  const t = setup({ Recognition, capabilities: () => ({ assessment: true, asr: false }) });
  await t.voice.toggle(); assert.equal(t.voice.phase, 'browser');
  const result = [{ transcript: '我想学这个词' }]; result.isFinal = true;
  instance.onresult({ results: [result] }); await t.voice.toggle(); assert.deepEqual(t.transcripts, [['我想学这个词','browser_asr']]);
  await t.voice.toggle(); t.voice.cancel(); instance.onresult({ results: [result] }); instance.onend(); assert.equal(t.transcripts.length, 1);
  assert.equal(t.requests.length, 0);
});
test('browser permission failure and an invalid stop state both recover to typing', async () => {
  let instance;
  class Recognition { constructor() { instance=this; } start() {} stop() { throw new Error('InvalidStateError'); } abort() {} }
  const t=setup({ Recognition, capabilities:()=>({asr:false}) });
  await t.voice.toggle();instance.onerror();assert.equal(t.voice.phase,'idle');
  await t.voice.toggle();await t.voice.toggle();assert.equal(t.voice.phase,'idle');assert.deepEqual(t.errors,['browser_failed','browser_failed']);
});
