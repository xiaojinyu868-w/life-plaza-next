import test from 'node:test';
import assert from 'node:assert/strict';
import { createTencentSoe, normalizeTencentResult, parsePcm16Wav, validateReferenceText } from '../server/tencent-soe.mjs';

// Synthetic audio and local fake sockets only. No credential reads, DNS, vendor requests or real voices.
const config = { appId: '1234567', secretId: 'test-id', secretKey: 'test-secret', timeoutMs: 500, handshakeTimeoutMs: 100 };
function chunk(id, data) {
  const value = Buffer.alloc(8 + data.length + data.length % 2);
  value.write(id); value.writeUInt32LE(data.length, 4); data.copy(value, 8); return value;
}
function fmt() {
  const value = Buffer.alloc(16); value.writeUInt16LE(1, 0); value.writeUInt16LE(1, 2); value.writeUInt32LE(16000, 4);
  value.writeUInt32LE(32000, 8); value.writeUInt16LE(2, 12); value.writeUInt16LE(16, 14); return value;
}
function riff(chunks) {
  const header = Buffer.alloc(12); header.write('RIFF'); header.write('WAVE', 8);
  const out = Buffer.concat([header, ...chunks]); out.writeUInt32LE(out.length - 8, 4); return out;
}
function wav(samples = 1600) {
  const data = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) data.writeInt16LE(i % 101, i * 2);
  return riff([chunk('fmt ', fmt()), chunk('data', data)]);
}
function vendorResult(extra = {}) {
  return {
    SentenceId: -1, SuggestedScore: 72.25, PronAccuracy: 82.5, PronFluency: 0.8, PronCompletion: 0.9,
    Words: [{ Word: '我', MatchTag: 0, PronAccuracy: 81.25, MemBeginTime: 10, MemEndTime: 90,
      Tone: { Valid: true, RefTone: 3, HypothesisTone: 4 },
      PhoneInfos: [{ Phone: 'w', PronAccuracy: 90, MatchTag: 0 }, { Phone: 'o3', PronAccuracy: 70, MatchTag: 0 }] }],
    ...extra,
  };
}
class FakeSocket extends EventTarget {
  constructor(url, onSend) { super(); this.url = url; this.voiceId = new URL(url).searchParams.get('voice_id'); this.readyState = 0; this.sent = []; this.closeCount = 0; this.onSend = onSend; this.listenerCount = 0; }
  addEventListener(...args) { this.listenerCount++; super.addEventListener(...args); }
  removeEventListener(...args) { this.listenerCount--; super.removeEventListener(...args); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(body) { this.raw(JSON.stringify({ voice_id: this.voiceId, code: 0, ...body })); }
  raw(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  handshake() { this.open(); this.message({}); }
  send(data) { this.sent.push(data); this.onSend?.(data, this); }
  close() { this.closeCount++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function harness(setup, overrides = {}, deps = {}) {
  const sockets = [];
  const adapter = createTencentSoe({ ...config, ...overrides }, {
    now: () => 1700000000000, nonce: () => 123456, voiceId: () => 'test-voice',
    webSocketFactory: (url) => { const socket = new FakeSocket(url); sockets.push(socket); queueMicrotask(() => setup?.(socket)); return socket; }, ...deps,
  });
  return { adapter, sockets, assess: (options = {}) => adapter.assess({ audio: wav(), referenceText: '我是谁', ...options }) };
}
function success(socket, result = vendorResult()) {
  socket.onSend = (data) => { if (typeof data === 'string') queueMicrotask(() => socket.message({ final: 1, result })); };
  socket.handshake();
}

test('extracts bounded mono PCM from standard WAV, handles padded metadata and does not retain input backing storage', () => {
  const input = riff([chunk('JUNK', Buffer.from([7, 8, 9])), chunk('fmt ', fmt()), chunk('data', Buffer.from([1, 2, 3, 4]))]);
  const parsed = parsePcm16Wav(input);
  assert.deepEqual(parsed.pcm, Buffer.from([1, 2, 3, 4])); assert.equal(parsed.durationMs, 0.125);
  input.fill(0); assert.equal(parsed.pcm[0], 1);
  assert.equal(parsePcm16Wav(wav(16000 * 60)).durationMs, 60000);
});

test('malformed, conflicting, compressed, wrong-rate and excessive WAV inputs fail before transport', async () => {
  const bad = [];
  for (const mutate of [
    (b) => b.write('RIFX', 0), (b) => b.writeUInt32LE(1, 4), (b) => b.write('AVI ', 8),
    (b) => b.writeUInt16LE(3, 20), (b) => b.writeUInt16LE(2, 22), (b) => b.writeUInt32LE(48000, 24),
    (b) => b.writeUInt32LE(64000, 28), (b) => b.writeUInt16LE(4, 32), (b) => b.writeUInt16LE(24, 34),
    (b) => b.writeUInt32LE(0xffffffff, 40),
  ]) { const b = wav(); mutate(b); bad.push(b); }
  bad.push(riff([chunk('fmt ', fmt()), chunk('data', Buffer.from([1]))]));
  bad.push(riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(0))]));
  bad.push(riff([chunk('data', Buffer.alloc(4)), chunk('fmt ', fmt())]));
  bad.push(riff([chunk('fmt ', fmt()), chunk('fmt ', fmt()), chunk('data', Buffer.alloc(4))]));
  bad.push(riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(4)), chunk('data', Buffer.alloc(4))]));
  bad.push(riff([chunk('fmt ', fmt()), Buffer.from([1, 2, 3])]));
  bad.push(wav(16000 * 60 + 1), Buffer.alloc(2_000_000), Buffer.alloc(44));
  const h = harness();
  for (const audio of bad) {
    assert.throws(() => parsePcm16Wav(audio), /soe_/);
    const result = await h.assess({ audio }); assert.equal(result.ok, false); assert.equal(result.overall, null);
  }
  assert.equal(h.sockets.length, 0);
});

test('reference policy enforces 30 Han characters and disallows caller-supplied vendor commands', () => {
  assert.equal(validateReferenceText(' 我是谁？ '), '我是谁？'); assert.equal(validateReferenceText('我'.repeat(30)).length, 30);
  for (const value of ['', '。', '我'.repeat(31), 'hello', 'abc我', '{::cmd{F_TDET=false}}我', '我\n是谁', null]) assert.throws(() => validateReferenceText(value), /soe_/);
});

test('signs raw sorted UTF-8 parameters, URL-encodes signature, waits for acknowledgement and sends exactly one PCM frame then end', async () => {
  const h = harness((socket) => {
    socket.open(); assert.equal(socket.sent.length, 0);
    socket.onSend = (data) => { if (typeof data === 'string') queueMicrotask(() => socket.message({ final: 1, result: vendorResult() })); };
    socket.message({});
  });
  const result = await h.assess(); const socket = h.sockets[0], url = new URL(socket.url), q = url.searchParams;
  assert.equal(url.origin, 'wss://soe.cloud.tencent.com'); assert.equal(url.pathname, '/soe/api/1234567');
  assert.equal(q.get('signature'), 'kdWnPQNIdIceTSxBUfICQWLbKZE='); // Independently calculated with .NET HMACSHA1.
  assert.ok(socket.url.endsWith('kdWnPQNIdIceTSxBUfICQWLbKZE%3D'));
  for (const [key, value] of Object.entries({ rec_mode: '1', eval_mode: '1', voice_format: '0', server_engine_type: '16k_zh', text_mode: '0', sentence_info_enabled: '0' })) assert.equal(q.get(key), value);
  assert.equal(q.get('ref_text'), '{::cmd{F_TDET=true}}我是谁'); assert.equal(q.get('expired'), '1700000300');
  assert.equal(socket.sent.length, 2); assert.deepEqual(socket.sent[0], wav().subarray(44)); assert.equal(socket.sent[1], '{"type":"end"}');
  assert.equal(result.ok, true); assert.equal(result.capability, 'L2'); assert.equal(result.overall, 72.25);
  assert.equal(result.transcript, ''); assert.equal(result.transcriptSource, 'none'); assert.equal(result.referenceText, '我是谁');
  assert.equal(result.words[0].wordSource, 'assessment-alignment'); assert.deepEqual(result.words[0].referenceRange, { start: 0, end: 1 });
  assert.equal(socket.closeCount, 1); assert.equal(socket.listenerCount, 0); assert.equal(result.seal, false);
});

test('uses official measured fields without recomputing suggested score or reconstructing a transcript', () => {
  const mapped = normalizeTencentResult(vendorResult({ Transcript: 'invented extra field' }), '我是谁');
  assert.equal(mapped.overall, 72.25); assert.equal(mapped.overallSource, 'SuggestedScore');
  assert.deepEqual(mapped.metrics, { accuracy: 82.5, fluency: 0.8, completeness: 0.9 });
  assert.deepEqual(mapped.words[0].chars[0].tone, { valid: true, ref: 3, got: 4, ok: false });
  assert.equal(mapped.words[0].chars[0].pinyin, ''); assert.equal(mapped.words[0].chars[0].phones[1].score, 70);
  assert.equal(mapped.words[0].start, 0.01); assert.equal(mapped.words[0].end, 0.09);
  assert.equal(mapped.transcript, ''); assert.ok(!JSON.stringify(mapped).includes('invented extra field'));
});

test('false, null, string and out-of-range tones never claim L2; valid pronunciation scores remain available', async () => {
  for (const tone of [null, {}, { Valid: false, RefTone: 3, HypothesisTone: 4 }, { Valid: 'true', RefTone: 3, HypothesisTone: 4 },
    ...[-1, 0, 5, null, '3'].flatMap((value) => [{ Valid: true, RefTone: value, HypothesisTone: 4 }, { Valid: true, RefTone: 3, HypothesisTone: value }])]) {
    const raw = vendorResult(); raw.Words[0].Tone = tone;
    const h = harness((s) => success(s, raw)); const result = await h.assess();
    assert.equal(result.ok, true); assert.equal(result.overall, 72.25); assert.equal(result.capability, 'pronunciation');
    assert.equal(result.toneStatus, 'unavailable'); assert.equal(result.words[0].chars[0].tone, null);
  }
});

test('missing/unrecorded words cannot supply scores or tones; additional and unaligned words have no reference tone claims', () => {
  for (const matchTag of [2, 4, null, 5, '0']) {
    const raw = vendorResult(); raw.Words[0].MatchTag = matchTag;
    const mapped = normalizeTencentResult(raw, '我是谁');
    assert.equal(mapped.ok, false); assert.equal(mapped.reason, 'soe_no_assessable_words'); assert.equal(mapped.overall, null);
  }
  for (const edit of [(word) => { word.MatchTag = 1; }, (word) => { word.Word = '他'; }, (word) => { word.Word = '我是'; }]) {
    const raw = vendorResult(); edit(raw.Words[0]); const mapped = normalizeTencentResult(raw, '我是谁');
    assert.equal(mapped.capability, 'pronunciation'); assert.equal(mapped.transcript, '');
    assert.ok(mapped.words.every((w) => w.chars.every((c) => !c.tone)));
  }
  const raw = vendorResult(); raw.Words = [structuredClone(raw.Words[0]), { ...raw.Words[0], Word: '是' }, structuredClone(raw.Words[0])];
  const mapped = normalizeTencentResult(raw, '我是我'); assert.deepEqual(mapped.words.map((w) => w.referenceRange?.start), [0, 1, 2]);
});

test('negative rejection scores, missing scores and malformed response fields fail without fabricated zero scores', () => {
  for (const extra of [{ PronAccuracy: -1 }, { SuggestedScore: -1 }, { SuggestedScore: 101 }, { SuggestedScore: '99' }, { SuggestedScore: undefined }, { Words: [] }, { Words: null }, { Words: Array(121).fill({}) }]) {
    const result = normalizeTencentResult(vendorResult(extra), '我是谁'); assert.equal(result.ok, false); assert.equal(result.overall, null); assert.deepEqual(result.words, []);
  }
  const raw = vendorResult(); raw.Words[0].MemBeginTime = 80000; raw.Words[0].PhoneInfos[0].PronAccuracy = -1;
  const mapped = normalizeTencentResult(raw, '我是谁'); assert.equal(mapped.words[0].start, null); assert.equal(mapped.words[0].chars[0].phones[0].score, null);
});

test('open speech and missing configuration do not create a socket or manufacture ASR text', async () => {
  let called = false;
  const adapter = createTencentSoe({}, { webSocketFactory: () => { called = true; throw new Error('unexpected'); } });
  const unavailable = await adapter.assess({ audio: wav(), referenceText: '我是谁' }); assert.equal(unavailable.reason, 'soe_not_configured');
  const open = await adapter.assess({ audio: wav(), mode: 'open' }); assert.equal(open.unsupported, true); assert.equal(open.mode, 'open'); assert.equal(open.transcript, ''); assert.equal(called, false);
});

test('handshake errors and no-voice refusal are bounded and do not expose vendor message or credentials', async () => {
  for (const code of [4002, 4003, 4004, 4005, 4006, 4007, 4105, 4108, 5000]) {
    const h = harness((s) => { s.open(); s.message({ code, message: `${s.url} PRIVATE RESPONSE` }); });
    const result = await h.assess(); assert.equal(result.ok, false); assert.equal(result.vendorCode, code); assert.equal(result.overall, null);
    assert.equal(result.rejected, [4105, 4108].includes(code)); assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes('test-secret')); assert.ok(!JSON.stringify(result).includes('signature'));
    assert.equal(h.sockets[0].sent.length, 0); assert.equal(h.sockets[0].closeCount, 1);
  }
});

test('acknowledgement must have matching voice id, valid JSON/code and no premature result', async () => {
  for (const send of [
    (s) => s.message({ voice_id: 'another-voice' }), (s) => s.message({ code: '0' }), (s) => s.raw('{'),
    (s) => s.message({ result: vendorResult() }), (s) => s.message({ final: 1 }), (s) => s.raw(new Uint8Array(4)),
  ]) {
    const h = harness((s) => { s.open(); send(s); }); const result = await h.assess();
    assert.equal(result.ok, false); assert.equal(h.sockets[0].sent.length, 0); assert.equal(h.sockets[0].closeCount, 1);
  }
});

test('complete result before final marker is retained, but intermediate sentences never substitute for a final summary', async () => {
  const complete = harness((s) => { s.handshake(); s.message({ result: JSON.stringify(vendorResult()) }); s.message({ final: 1 }); });
  assert.equal((await complete.assess()).ok, true);
  const incomplete = harness((s) => { s.handshake(); s.message({ result: vendorResult({ SentenceId: 0 }) }); s.message({ final: 1 }); });
  assert.equal((await incomplete.assess()).reason, 'soe_missing_final_result');
});

test('unopened transport and opened connection with no acknowledgement have bounded handshake timeouts', async () => {
  for (const setup of [() => {}, (s) => s.open()]) {
    const h = harness(setup, { handshakeTimeoutMs: 25 }); const started = Date.now(); const result = await h.assess();
    assert.equal(result.reason, 'soe_handshake_timeout'); assert.ok(Date.now() - started < 500);
    assert.equal(h.sockets[0].sent.length, 0); assert.equal(h.sockets[0].closeCount, 1);
  }
});

test('hard deadline covers a stalled final response and a non-cooperating audio body conversion', async () => {
  const h = harness((s) => s.handshake(), { timeoutMs: 30, handshakeTimeoutMs: 20 });
  assert.equal((await h.assess()).reason, 'soe_timeout'); assert.equal(h.sockets[0].sent.length, 2); assert.equal(h.sockets[0].closeCount, 1);
  class StalledBlob extends Blob { arrayBuffer() { return new Promise(() => {}); } }
  const body = harness(() => {}, { timeoutMs: 25 }); const started = Date.now();
  assert.equal((await body.assess({ audio: new StalledBlob([wav()]) })).reason, 'soe_timeout');
  assert.equal(body.sockets.length, 0); assert.ok(Date.now() - started < 500);
});

test('AbortSignal cancels before upload, during handshake and after upload, and removes listeners', async () => {
  const already = new AbortController(); already.abort(); const pre = harness();
  assert.equal((await pre.assess({ signal: already.signal })).reason, 'soe_cancelled'); assert.equal(pre.sockets.length, 0);
  for (const uploaded of [false, true]) {
    const controller = new AbortController();
    const h = harness((s) => { if (uploaded) s.handshake(); controller.abort(new Error('private reason')); });
    const result = await h.assess({ signal: controller.signal }); assert.equal(result.reason, 'soe_cancelled');
    assert.equal(h.sockets[0].closeCount, 1); assert.equal(h.sockets[0].listenerCount, 0); assert.equal(h.sockets[0].sent.length, uploaded ? 2 : 0);
    assert.ok(!JSON.stringify(result).includes('private reason'));
  }
});

test('premature close, error and construction failure return sanitized transport failures', async () => {
  for (const setup of [(s) => { s.readyState = 3; s.dispatchEvent(new Event('close')); }, (s) => s.dispatchEvent(new Event('error'))]) {
    const h = harness(setup); assert.equal((await h.assess()).ok, false);
  }
  const h = harness(null, {}, { webSocketFactory: (url) => { throw new Error(url); } });
  const result = await h.assess(); assert.equal(result.reason, 'soe_transport_unavailable'); assert.ok(!JSON.stringify(result).includes('secretid'));
});

test('oversized or malformed response bodies are rejected and post-final messages cannot change a settled result', async () => {
  for (const send of [(s) => s.raw('x'.repeat(270000)), (s) => s.message({ result: 'not json', final: 1 }), (s) => s.message({ final: 9 }), (s) => s.raw('null')]) {
    const h = harness((s) => { s.handshake(); send(s); }); const result = await h.assess(); assert.equal(result.ok, false); assert.equal(result.overall, null);
  }
  const h = harness((s) => { s.handshake(); s.message({ final: 1, result: vendorResult() }); s.message({ code: 4002 }); s.raw('{'); s.dispatchEvent(new Event('error')); });
  const result = await h.assess(); assert.equal(result.ok, true); assert.equal(result.overall, 72.25); assert.equal(h.sockets[0].closeCount, 1);
});

test('WebSocket class injection works with Blob audio and binary invalid MIME never bypasses WAV checks', async () => {
  class InjectedSocket extends FakeSocket { constructor(url) { super(url); queueMicrotask(() => success(this)); } }
  const adapter = createTencentSoe(config, { WebSocketImpl: InjectedSocket });
  assert.equal((await adapter.assess({ audio: new Blob([wav()], { type: 'application/octet-stream' }), referenceText: '我是谁' })).ok, true);
  assert.equal((await adapter.assess({ audio: new Blob(['not audio'], { type: 'audio/wav' }), referenceText: '我是谁' })).ok, false);
});
