const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../src/net.js');
const { wav16k } = require('../src/speech.js');
const make = (fetchImpl) => createClient({ fetchImpl, randomUUID: () => 'abcdef-12345678' });
test('offline lesson sends no requests and preserves a local line without an evidence seal', async () => {
  let n = 0; const c = make(() => { n++; });
  const r = await c.turn({}, { zh: '你好。' }); assert.equal(r.zh, '你好。'); assert.equal(r.seal, false); assert.deepEqual(r.evidence, []);
  assert.equal(await c.event('nev-l4', 'hint_used', {}), false); assert.equal(n, 0);
});
test('turn strips a provider response claiming a corpus seal by using fallback', async () => {
  const c = make(async () => ({ ok: true, json: async () => ({ ok: true, zh: '编的。', seal: true }) })); c.setEnabled(true);
  assert.equal((await c.turn({}, { zh: '原脚本。' })).zh, '原脚本。');
});
test('switching offline aborts in-flight requests and ignores late results', async () => {
  let done, signal; const c = make((_, o) => { signal = o.signal; return new Promise(r => done = r); }); c.setEnabled(true);
  const pending = c.turn({}, { zh: '本地。' }); c.setEnabled(false);
  assert.equal(signal.aborted, true); done({ ok: true, json: async () => ({ ok: true, zh: '迟到的。', seal: false }) });
  assert.equal((await pending).zh, '本地。');
});
test('request timeout survives an uncooperative provider', async () => {
  const c = make(() => new Promise(() => {})); c.setEnabled(true);
  await assert.rejects(c.request('/api/status', undefined, 20), /timeout/);
});
test('request deadline also covers a stalled JSON response body', async () => {
  const c = make(async () => ({ ok: true, json: () => new Promise(() => {}) })); c.setEnabled(true);
  await assert.rejects(c.request('/api/status', undefined, 20), /timeout/);
});
test('audio is mono 16k PCM with bounded sample values and correct duration', () => {
  const input = new Float32Array(48000).fill(0.5); const v = new DataView(wav16k(input, 48000));
  assert.equal(v.byteLength, 32044); assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint16(22, true), 1); assert.equal(v.getInt16(44, true), 16384);
  const clipped = new DataView(wav16k(new Float32Array([2, -2]), 16000)); assert.equal(clipped.getInt16(44, true), 32767); assert.equal(clipped.getInt16(46, true), -32768);
});
