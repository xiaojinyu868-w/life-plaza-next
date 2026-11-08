import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server/index.mjs';
import { configuration, createServices, cleanEvent, toneFeedback } from '../server/services.mjs';
import { cleanTurn, validateNpc, overLevel, DATA, ERROR_SAMPLES, readLesson, validateLesson, inferLookup, renderLookup } from '../server/canonical.mjs';
import { evaluate } from '../server/evaluate-npc.mjs';

const base = { sessionId: 's_abcdefghijkl123456', lesson: 'nev-l4', station: 'c', step: 'dragon-why', role: 'dragon', level: 2, plugged: true, userText: '为什么？' };
const output = { intent: 'ask_back', zh: '为什么呀？师傅。', en: 'Why, master?', evidence: [], seal: false };
const chat = (candidate) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), { status: 200 });
const configured = (extra = {}) => ({ ...configuration({}), llmUrl: 'https://example.test/chat/completions', llmKey: 'test-only', llmModel: 'mock-model', ...extra });

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-server-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function httpApp(t, opts = {}) {
  const dir = await temporary(t);
  const staticDir = path.join(dir, 'dist');
  await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, '插电工坊.html'), '<h1>workshop</h1>');
  const { server, service } = createApp({ ...opts, config: { ...configuration({}), dataDir: path.join(dir, 'data'), ...opts.config }, staticDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { server, service, dir, url: `http://127.0.0.1:${server.address().port}` };
}
const post = (url, data, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('no provider configuration never calls a remote service; original script fallback remains available', async () => {
  const service = createServices(configuration({}), { fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(service.capabilities().npc, false);
  const r = await service.npc(base);
  assert.equal(r.source, 'script'); assert.equal(r.seal, false); assert.equal(r.zh, '为什么叫混合动力汽车？');
});
test('coaching recomputes the answer using the trusted lesson and changes the second hint', async () => {
  const body = { ...base, station: 'a', step: 'recog-engine', purpose: 'feedback', userText: '电池', correct: true, answer: '电池', attempt: 1 };
  const firstTurn = cleanTurn(body); assert.equal(firstTurn.coaching.correct, false); assert.equal(firstTurn.coaching.target, '发动机');
  assert.equal(validateNpc({ intent: 'praise', zh: '你说对了。', seal: false }, firstTurn).ok, false);
  const first = validateNpc({ intent: 'answer', lookup: { kind: 'feedback', style: 'hint' }, seal: false }, firstTurn);
  assert.equal(first.ok, true); assert.equal(first.value.grounding.correct, false); assert.match(first.value.zh, /发动机/); assert.equal(first.value.seal, false);
  const second = await createServices(configuration({})).npc({ ...body, attempt: 2, history: [{ who: 'wang', zh: first.value.zh }] });
  assert.notEqual(second.zh, first.value.zh); assert.equal(second.grounding.correct, false);
  assert.throws(() => cleanTurn({ ...body, station: 'c' }), /unknown_coaching_prompt/);
  assert.throws(() => cleanTurn({ ...body, lesson: 'nev-l5' }), /unknown_coaching_prompt/);
});
test('confirmation coaching gives an answer instead of incorrectly teaching the learner to ask a question', async () => {
  const service = createServices(configuration({}));
  const intro = await service.npc({ ...base, station: 'intro', step: 'intro-answer', purpose: 'feedback', userText: '你好' });
  assert.match(intro.zh, /对/); assert.doesNotMatch(intro.zh, /对吗|再问/);
  const fact = await service.npc({ ...base, station: 'c', step: 'confirm-fact-1', purpose: 'feedback', userText: '对' });
  assert.match(fact.zh, /不是.*有发动机/); assert.doesNotMatch(fact.zh, /对吗|再问/);
});
test('model intent and final question marks cannot launder an invented learner error or vehicle claim', () => {
  const turn = cleanTurn(base);
  for (const candidate of [{ intent:'ask_back', zh:'也我有车。' }, { intent:'praise', zh:'它没有发动机，对吗？' }, { intent:'ask_back', zh:'纯电车有发动机吗？' }]) {
    const result = validateNpc({ ...candidate, seal:false }, turn); assert.equal(result.ok, false);
  }
  assert.equal(validateNpc({ intent:'ask_back', zh:'为什么呀？师傅。', seal:false }, turn).ok, true);
});
test('pronoun facts follow the visible vehicle; explicit vehicle names take precedence', async () => {
  const service = createServices(configuration({}));
  const request = { ...base, role:'wang', focus:'bev', userText:'它有发动机吗？' };
  const response = await service.npc(request); assert.match(response.zh, /没有发动机/);
  const turn = cleanTurn(request);
  assert.equal(validateNpc({ intent:'answer', lookup:{kind:'fact',subject:'phev',predicate:'engine'}, seal:false },turn).ok,false);
  assert.equal(validateNpc({ intent:'answer', lookup:{kind:'fact',subject:'bev',predicate:'engine'}, seal:false },turn).ok,true);
  assert.match((await service.npc({...request,userText:'插电式混合动力汽车有发动机吗？'})).zh,/它有发动机/);
});
test('diagnostic traces are opt-in, bounded, omit request secrets, and cannot change classroom results', async () => {
  const events = [];
  const service = createServices(configured(), { fetchImpl: async (_url, options) => { const request = JSON.parse(options.body); assert.equal(request.max_tokens, 80); return chat(output); }, onNpcTrace: e => { events.push(e); throw new Error('observer failure'); } });
  const r = await service.npc(base); assert.equal(r.source, 'llm');
  assert.deepEqual(events.map(e=>e.phase), ['request','response','validation','finish']);
  assert.equal(events[0].requestIndex, 1); assert.equal(events[2].accepted, true); assert.equal(events[3].usage.complete, true);
  assert.equal(events[1].usage.inputTokens, 50); assert.equal(events[1].content, JSON.stringify(output));
  assert.doesNotMatch(JSON.stringify(events), /test-only|Bearer|Authorization|system/);
});

test('validated dialogue uses the same HSK data, reports all over-level tokens, never seals generated output', async () => {
  const service = createServices(configured(), { fetchImpl: async () => chat(output) });
  const r = await service.npc(base);
  assert.equal(r.source, 'llm'); assert.equal(r.zh, output.zh); assert.equal(r.seal, false);
  assert.deepEqual(r.overLevel, overLevel(output.zh, 2)); assert.equal(r.usage.inputTokens, 50);
});

test('validated Chinese cannot smuggle unchecked facts through English or teacher text', () => {
  const turn = cleanTurn({ ...base, role: 'wang', userText: '纯电动汽车有发动机吗？' });
  const checked = validateNpc({ intent: 'answer', zh: '它没有发动机。', fact: { subject: 'bev', predicate: 'engine' }, en: 'This car has a diesel engine and a 9999 km range.', teacher: 'Invented specification', seal: false }, turn);
  assert.equal(checked.ok, true);
  assert.doesNotMatch(checked.value.en, /diesel|9999/);
  assert.equal(checked.value.teacher, '');
  const general = validateNpc({ ...output, en: 'A new unverified fact.', teacher: 'Another unverified claim' }, cleanTurn(base));
  assert.equal(general.ok, true); assert.equal(general.value.en, '');
});

test('length/level failures get at most one retry, then fall back', async () => {
  let calls = 0;
  const service = createServices(configured(), { fetchImpl: async () => { calls++; return chat({ ...output, zh: '为什么'.repeat(15) }); } });
  const r = await service.npc(base);
  assert.equal(calls, 2); assert.equal(r.source, 'script'); assert.equal(r.fallbackReason, 'too_long');
});

test('retry can recover short valid dialogue', async () => {
  let calls = 0;
  const service = createServices(configured(), { fetchImpl: async () => chat(++calls === 1 ? { ...output, zh: '为什么'.repeat(15) } : output) });
  const r = await service.npc(base);
  assert.equal(calls, 2); assert.equal(r.source, 'llm');
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, requests: 2, complete: true });
});

test('provider timeout returns script within the turn deadline', async () => {
  const service = createServices(configured(), { fetchImpl: (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
  const start = Date.now();
  const r = await service.npc({ ...base, budget: { timeoutMs: 100 } });
  assert.equal(r.source, 'script'); assert.equal(r.fallbackReason, 'provider_timeout'); assert.ok(Date.now() - start < 1000);
});

test('hard deadline covers a provider ignoring abort before headers', async () => {
  let called = false;
  const service = createServices(configured(), { fetchImpl: () => { called = true; return new Promise(() => {}); } });
  const start = Date.now();
  const r = await service.npc({ ...base, budget: { timeoutMs: 100 } });
  assert.equal(r.fallbackReason, 'provider_timeout'); assert.ok(called); assert.ok(Date.now() - start < 1000);
  assert.equal(r.usage.requests, 1); assert.equal(r.usage.complete, false);
});

test('hard deadline covers response bodies that stall after headers', async () => {
  let cancelled = false;
  const service = createServices(configured(), { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  })) });
  const start = Date.now();
  const r = await service.npc({ ...base, budget: { timeoutMs: 100 } });
  assert.equal(r.fallbackReason, 'provider_timeout'); assert.ok(cancelled); assert.ok(Date.now() - start < 1000);
});

test('provider errors and malformed JSON do not leak provider response or credentials', async () => {
  const bad = createServices(configured(), { fetchImpl: async () => new Response('private-provider-detail', { status: 401 }) });
  const r = await bad.npc(base);
  assert.equal(r.source, 'script'); assert.equal(r.fallbackReason, 'provider_http_401');
  assert.ok(!JSON.stringify(r).includes('private-provider-detail'));
  const malformed = createServices(configured(), { fetchImpl: async () => new Response('{', { status: 200 }) });
  assert.equal((await malformed.npc(base)).source, 'script');
});

test('client facts and allowed errors cannot authorize a false vehicle claim', async () => {
  const request = { ...base, role: 'wang', userText: '纯电动汽车有发动机吗？', facts: { bev: { engine: true } }, allowedErrors: ['invented'] };
  const service = createServices(configured(), { fetchImpl: async () => chat({ ...output, intent: 'answer', zh: '它有发动机。', fact: { subject: 'bev', predicate: 'engine' } }) });
  const r = await service.npc(request);
  assert.equal(r.zh, '它没有发动机。'); assert.equal(r.source, 'llm');
  const rejected = validateNpc({ ...output, intent: 'answer', zh: '它有发动机。' }, cleanTurn(request));
  assert.equal(rejected.ok, false);
});

test('arbitrary numeric/car claims and forged seals are rejected without retry', async () => {
  for (const candidate of [
    { ...output, intent: 'answer', zh: '续航1000公里。' },
    { ...output, intent: 'answer', zh: '它会飞。' },
    { ...output, seal: true },
    { ...output, evidence: ['ln-ye-1'] },
  ]) {
    let calls = 0;
    const service = createServices(configured(), { fetchImpl: async () => { calls++; return chat(candidate); } });
    assert.equal((await service.npc(base)).source, 'script'); assert.equal(calls, 1);
  }
});

test('error demonstrations require exact whitelisted evidence or an exact continuous excerpt, including offline corpus mode', () => {
  const turn = cleanTurn(base);
  assert.equal(validateNpc({ ...output, intent: 'error_demo', zh: '我会中文也。', evidence: ['ln-ye-1'] }, turn).reason, 'unverified_error');
  const sample = ERROR_SAMPLES.find((x) => x.kind === 'excerpt' && x.id === 'ln-ye-2');
  assert.ok(DATA.EV[sample.id].zh.includes(sample.zh));
  const valid = validateNpc({ ...output, intent: 'error_demo', zh: sample.zh }, { ...turn, level: 0, maxChars: 24 });
  assert.equal(valid.ok, true); assert.deepEqual(valid.value.evidence, ['ln-ye-2']); assert.equal(valid.value.seal, false);
  assert.equal(validateNpc({ ...output, intent: 'error_demo', zh: sample.zh }, cleanTurn({ ...base, plugged: false })).reason, 'unverified_error');
});

test('per-session model budget falls back without further requests', async () => {
  let calls = 0;
  const service = createServices(configured({ llmSessionLimit: 1 }), { fetchImpl: async () => { calls++; return chat(output); } });
  assert.equal((await service.npc(base)).source, 'llm');
  assert.equal((await service.npc(base)).fallbackReason, 'session_quota'); assert.equal(calls, 1);
});

test('bundled evidence retains query, source, count and retrieval date and requires no token', async () => {
  const service = createServices(configuration({}));
  const item = await service.evidence('ln-ye-1');
  assert.equal(item.source, 'snapshot'); assert.equal(item.hits, 397); assert.ok(item.at); assert.ok(item.src); assert.equal(item.q, '也CJX');
  const result = await service.corpusSearch({ channel: 2, pattern: '也CJX', limit: 10, page: 0, window: 20 });
  assert.equal(result.source, 'snapshot'); assert.ok(result.records.some((x) => x.id === 'ln-ye-1'));
  await assert.rejects(() => service.evidence('__proto__'), /evidence_not_found/);
  await assert.rejects(() => service.corpusSearch({ channel: 0, pattern: '也 Context(20,0,100000)' }), /use_bounded_search_parameters/);
});

test('corpus cache is persistent, includes context window, and does not relabel raw upstream records as verified evidence', async (t) => {
  const dataDir = await temporary(t); let calls = 0;
  const config = configured({ dataDir, corpusToken: 'test-only', llmUrl: '' });
  const mock = async () => { calls++; return new Response(JSON.stringify({ hits: 3, rows: ['unverified shape'] })); };
  const first = createServices(config, { fetchImpl: mock });
  const query = { channel: 0, pattern: '测试 n{}', window: 20, limit: 3, page: 0 };
  const a = await first.corpusSearch(query);
  assert.equal(a.source, 'remote-unverified'); assert.equal(a.verifiedEvidence, false); assert.deepEqual(a.records, []);
  const restarted = createServices(config, { fetchImpl: mock });
  const cached = await restarted.corpusSearch(query);
  assert.equal(cached.source, 'cache'); assert.deepEqual(cached.raw, a.raw); assert.equal(cached.retrievedAt, a.retrievedAt); assert.equal(calls, 1);
  await restarted.corpusSearch({ ...query, window: 40 }); assert.equal(calls, 2);
});

test('duplicate concurrent corpus queries coalesce; unknown query without token stays unavailable', async (t) => {
  let calls = 0;
  const service = createServices(configured({ dataDir: await temporary(t), corpusToken: 'test-only' }), { fetchImpl: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return new Response('{}'); } });
  const query = { channel: 0, pattern: '从未查询 n{}', limit: 3 };
  const values = await Promise.all([service.corpusSearch(query), service.corpusSearch(query)]);
  assert.equal(calls, 1); assert.equal(values[0].retrievedAt, values[1].retrievedAt);
  const offline = createServices(configuration({}));
  assert.equal((await offline.corpusSearch(query)).reason, 'not_configured');
});

function speechForm(mode = 'read') {
  const body = new FormData(); body.set('audio', new Blob([new Uint8Array(300)], { type: 'audio/wav' }), 'speech.wav');
  body.set('mode', mode); body.set('sessionId', base.sessionId); body.set('refText', mode === 'read' ? '驱动电机' : '');
  return body;
}
test('missing speech providers never fabricate pronunciation scores', async () => {
  const r = await createServices(configuration({})).speech(speechForm());
  assert.equal(r.ok, false); assert.equal(r.capability, 'unavailable'); assert.equal(r.overall, null); assert.equal(r.seal, false);
});

test('ASR provider receives audio but no reference-text prompt; result explicitly L1', async () => {
  const service = createServices(configured({ asrUrl: 'https://asr.test/transcriptions', asrKey: 'test-only', asrModel: 'mock' }), { fetchImpl: async (_url, req) => {
    assert.equal(req.body.get('prompt'), null); assert.equal(req.body.get('refText'), null); assert.ok(req.body.get('file') instanceof Blob);
    return new Response(JSON.stringify({ text: '驱动电机' }));
  } });
  const r = await service.speech(speechForm());
  assert.equal(r.capability, 'L1'); assert.equal(r.transcript, '驱动电机'); assert.equal(r.overall, null); assert.deepEqual(r.words, []);
});

test('real tone observations produce bounded executable drills, never corpus seals', async () => {
  const service = createServices(configured({ assessmentUrl: 'https://assess.test/assess', assessmentKey: 'test-only' }), { fetchImpl: async () => new Response(JSON.stringify({
    ok: true, transcript: '去动电机', transcriptSource: 'recognition', overall: 62, vendor: 'test-adapter', words: [{ w: '驱动电机', score: 62, chars: [{ c: '驱', pinyin: 'qū', score: 41, tone: { valid: true, ref: 1, got: 4, ok: true }, phones: [{ p: 'q', score: 88 }] }] }],
  })) });
  const r = await service.speech(speechForm());
  assert.equal(r.capability, 'L2'); assert.equal(r.words[0].chars[0].tone.ok, false); assert.equal(r.seal, false);
  assert.match(r.issues[0].say, /平着读/); assert.ok(r.issues[0].drill.includes('驱动电机'));
});

test('assessment without explicit tone evidence cannot masquerade as L2 and falls back to ASR', async () => {
  const service = createServices(configured({ assessmentUrl: 'https://assess.test/assess', assessmentKey: 'test-only', asrUrl: 'https://asr.test/transcriptions', asrKey: 'test-only', asrModel: 'mock' }), { fetchImpl: async (url) => new Response(JSON.stringify(url.includes('assess') ? { ok: true, transcript: '驱动电机', overall: 99, words: [] } : { text: '驱动电机' })) });
  const r = await service.speech(speechForm('open'));
  assert.equal(r.capability, 'L1'); assert.equal(r.overall, null); assert.equal(r.assessmentReason, 'open_requires_independent_asr');
});

test('Tencent reference-aligned assessment is never passed off as an ASR transcript', async () => {
  let calls = 0;
  const service = createServices(configuration({}), { tencentFactory: () => ({ configured: true, assess: async (input) => {
    calls++; assert.equal(input.referenceText, '驱动电机'); assert.equal(input.mode, 'read');
    return { ok: true, overall: 65, transcript: '驱动电机', transcriptSource: 'none', vendor: 'tencent-soe', words: [{ w: '驱动电机', chars: [{ c: '驱', tone: { valid: true, ref: 1, got: 4 } }] }] };
  } }) });
  const r = await service.speech(speechForm());
  assert.equal(r.capability, 'L2'); assert.equal(r.transcript, ''); assert.equal(r.transcriptSource, 'none'); assert.equal(r.seal, false); assert.equal(calls, 1);
  const open = await service.speech(speechForm('open'));
  assert.equal(open.ok, false); assert.equal(calls, 1, 'open answers cannot be assessed against a pre-filled reference');
});

test('untrusted assessment alignment and invalid Tone.Valid cannot create L2; falls back to independent ASR', async () => {
  for (const words of [
    [{ w: '驱动电机', chars: [{ c: '驱', tone: { valid: false, ref: 1, got: 4 } }] }],
    [{ w: '坏数据', chars: [{ c: '坏', tone: { valid: true, ref: 4, got: 1 } }] }],
    [{ w: '驱动电机', chars: [{ c: '坏', tone: { valid: true, ref: 4, got: 1 } }] }],
  ]) {
    const service = createServices(configured({ asrUrl: 'https://asr.test/transcriptions', asrKey: 'test-only', asrModel: 'mock' }), {
      tencentFactory: () => ({ configured: true, assess: async () => ({ ok: true, overall: 99, words }) }),
      fetchImpl: async () => new Response(JSON.stringify({ text: '去动电机' })),
    });
    const r = await service.speech(speechForm()); assert.equal(r.capability, 'L1'); assert.equal(r.transcript, '去动电机'); assert.equal(r.transcriptSource, 'recognition'); assert.equal(r.overall, null);
  }
});

test('speech context validation precedes any provider call', async () => {
  const service = createServices(configuration({}), { tencentFactory: () => ({ configured: true, assess: () => { throw new Error('must not call'); } }) });
  const form = speechForm(); form.set('lesson', '../../secret'); await assert.rejects(service.speech(form), /invalid_speech_context/);
});

test('events whitelist educational fields and discard names, raw transcripts, audio, client timestamps and nested objects', () => {
  const r = cleanEvent({ sessionId: base.sessionId, lesson: 'nev-l4', type: 'speak_attempt', t: -1, payload: { name: 'Somebody', audio: 'secret-bytes', transcript: 'my name is Somebody', station: 'a', target: '发动机', correct: true, attempt: 2, inputMode: 'cloud_asr', address: { nested: 'secret' } } }, 1234);
  assert.equal(r.t, 1234); assert.deepEqual(r.payload, { station: 'a', target: '发动机', correct: true, attempt: 2, inputMode: 'cloud_asr' });
  assert.throws(() => cleanEvent({ sessionId: 'real-name', lesson: 'nev-l4', type: 'answer' }), /invalid_event/);
});

test('HTTP static app, status, anonymous event persistence and teacher aggregate work end to end', async (t) => {
  const app = await httpApp(t);
  assert.match(await (await fetch(app.url)).text(), /workshop/);
  assert.equal((await (await fetch(app.url + '/api/status')).json()).capabilities.npc, false);
  for (const type of ['session_start', 'speak_attempt', 'hint_used', 'session_finish']) {
    assert.equal((await post(app.url + '/api/learn/event', { sessionId: base.sessionId, lesson: 'nev-l4', type, payload: { station: 'a', name: 'not saved', inputMode: 'cloud_asr', asrOk: true } })).status, 200);
  }
  assert.equal((await post(app.url + '/api/learn/event', { sessionId: base.sessionId, lesson: 'nev-l4', type: 'pronunciation_attempt', payload: { station: 'a', target: '发动机', capability: 'L2', score: 61, transcript: 'must not persist' } })).status, 200);
  const summary = await (await fetch(app.url + '/api/teacher/summary')).json();
  assert.equal(summary.sessions, 1); assert.equal(summary.completedSessions, 1); assert.equal(summary.speechAttempts, 1); assert.equal(summary.hints, 1);
  assert.equal(summary.pronunciationAttempts, 1, 'assessment attempts remain separate from recognized speech');
  const raw = await fs.readFile(path.join(app.dir, 'data/learning-events.jsonl'), 'utf8');
  assert.ok(!raw.includes('not saved')); assert.ok(!JSON.stringify(summary).includes(base.sessionId));
  assert.ok(!raw.includes('must not persist'));
});

test('HTTP security rejects foreign origin, rebinding host, oversized JSON, nonexistent assets and protected teacher access', async (t) => {
  const app = await httpApp(t, { config: { teacherToken: 'teacher-test-secret' } });
  assert.equal((await post(app.url + '/api/npc/turn', base, { Origin: 'https://attacker.test' })).status, 403);
  const rebound = await new Promise((resolve, reject) => http.get(app.url + '/api/status', { headers: { Host: 'attacker.test' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(rebound, 403);
  assert.equal((await post(app.url + '/api/npc/turn', { ...base, userText: 'x'.repeat(33000) })).status, 413);
  assert.equal((await fetch(app.url + '/.env')).status, 404);
  assert.equal((await fetch(app.url + '/api/teacher/summary')).status, 401);
  assert.equal((await fetch(app.url + '/api/teacher/summary', { headers: { Authorization: 'Bearer teacher-test-secret' } })).status, 200);
});

test('HTTP multipart validation and cloud-unavailable fallback preserve privacy', async (t) => {
  const app = await httpApp(t);
  const response = await fetch(app.url + '/api/speech/assess', { method: 'POST', body: speechForm() });
  assert.equal(response.status, 200); assert.equal((await response.json()).overall, null);
  const invalid = speechForm(); invalid.set('audio', new Blob(['not audio'], { type: 'text/plain' }), 'secret.txt');
  assert.equal((await fetch(app.url + '/api/speech/assess', { method: 'POST', body: invalid })).status, 400);
  await assert.rejects(() => fs.stat(path.join(app.dir, 'data')), /ENOENT/);
});

test('real lesson packages use the shared command schema; invalid commands, references, finish and paths fail closed', async (t) => {
  assert.ok(readLesson('nev-l4')); assert.ok(readLesson('nev-l5'));
  assert.equal(readLesson('../nev-l4'), null); assert.equal(readLesson('unknown-package'), null);
  const source = readLesson('nev-l4');
  for (const corrupt of [
    (v) => { v.schemaVersion = 999; },
    (v) => { v.stations[0].commands[0] = { op: 'eval', code: 'process.exit()' }; },
    (v) => { v.stations[0].commands[0] = { op: 'say', who: 'wang', line: { zh: '例句' }, options: { seal: 'invented-evidence' } }; },
    (v) => { v.stations.at(-1).commands.pop(); },
    (v) => { v.stations[0].id = '../escape'; },
  ]) { const copy = structuredClone(source); corrupt(copy); assert.equal(validateLesson(copy, 'nev-l4'), false); }
  const dir = await temporary(t);
  await fs.writeFile(path.join(dir, 'nev-l4.json'), '{malformed');
  assert.equal(readLesson('nev-l4', dir), null);
  assert.throws(() => cleanTurn({ ...base, step: 'a-认-发动机' }), /invalid_step/);
});

test('canonical word lookups discard invented wording and client dictionaries, and retain provenance', async () => {
  const service = createServices(configured(), { fetchImpl: async () => chat({ intent: 'answer', lookup: { kind: 'word', word: '驱动电机', field: 'meaning' }, zh: '它有一千马力。', en: 'invented', seal: false }) });
  const result = await service.npc({ ...base, role: 'wang', userText: '驱动电机是什么意思？', dictionary: { 驱动电机: ['x', 'can fly'] } });
  assert.equal(result.source, 'llm'); assert.equal(result.zh, '驱动电机：driving motor。');
  assert.match(result.grounding.sourceRef, /nev-l4\.json#dict/); assert.ok(!JSON.stringify(result).includes('can fly'));
  assert.equal(validateNpc({ intent: 'answer', lookup: { kind: 'word', word: '发动机' } }, cleanTurn({ ...base, userText: '驱动电机是什么意思？' })).reason, 'invalid_lookup');
  for (const lookup of [{ kind: 'grammar', point: '__proto__' }, { kind: 'support', need: '__proto__' }]) assert.equal(renderLookup(lookup, cleanTurn(base)), null);
});

test('example routing ignores request scaffolding, retrieves exact excerpts and cannot invent evidence', () => {
  const turn = cleanTurn({ ...base, userText: '给也一个例句。' });
  assert.deepEqual(inferLookup(turn), { kind: 'example', word: '也' });
  const result = renderLookup(inferLookup(turn), turn);
  assert.equal(result.evidence[0], 'vd-ye'); assert.ok(DATA.EV['vd-ye'].zh.includes(result.zh)); assert.equal(result.seal, false);
  assert.equal(validateNpc({ intent: 'answer', lookup: inferLookup(turn), evidence: ['ln-ye-1'] }, turn).reason, 'unverified_evidence');
  const unplugged = renderLookup(inferLookup(turn), { ...turn, plugged: false });
  assert.ok(!unplugged || unplugged.grounding.kind !== 'snapshot-excerpt');
});

test('lesson 5 dictionary terms stay professional, ungraded and explicitly pending review', async () => {
  const request = { ...base, lesson: 'nev-l5', userText: '能量回收的英文怎么说？' };
  const result = await createServices(configuration({})).npc(request);
  assert.equal(result.intent, 'answer'); assert.match(result.zh, /energy recovery/);
  assert.equal(result.grounding.provenance, 'authored-pending-review');
  assert.deepEqual(result.overLevel, [{ w: '能量回收', hsk: null, en: 'energy recovery', professional: true }]);
  assert.equal(result.evidence.length, 0); assert.equal(result.seal, false);
  const goal = await createServices(configuration({})).npc({ ...request, userText: '今天学什么？' });
  assert.match(goal.zh, /制动/); assert.ok(!goal.zh.includes('对吗'));
  assert.equal(goal.grounding.provenance, 'authored-pending-review');
});

test('support and example queries remain grounded; learning goals and word chains never claim prerequisites', () => {
  const turn = cleanTurn({ ...base, userText: '我很紧张。', level: 0 });
  const first = renderLookup({ kind: 'support', need: 'nervous' }, turn);
  const second = renderLookup({ kind: 'support', need: 'nervous' }, { ...turn, history: [{ who: 'dragon', zh: first.zh }] });
  assert.notEqual(first.zh, second.zh); assert.equal(second.grounding.kind, 'teaching');
  const chain = renderLookup({ kind: 'chain', character: '电' }, cleanTurn({ ...base, userText: '带电字还有什么词？' }));
  assert.match(chain.en, /not a prerequisite/); assert.deepEqual(chain.evidence, []);
});

test('event labels cannot hide free text, private names or invented evidence; typing never counts as speech', async (t) => {
  const dataDir = await temporary(t);
  const service = createServices({ ...configuration({}), dataDir });
  const event = { sessionId: base.sessionId, lesson: 'nev-l4', type: 'speak_attempt', payload: { target: 'My name is Alice', word: 'Alice', evidenceId: 'invented', step: 'Alice的姓名', inputMode: 'text', asrOk: true } };
  const cleaned = cleanEvent(event); assert.deepEqual(cleaned.payload, { inputMode: 'text', asrOk: true });
  await service.event(event);
  await service.event({ ...event, payload: { inputMode: 'choice', asrOk: true } });
  await service.event({ ...event, payload: { inputMode: 'cloud_asr', asrOk: true } });
  await service.event({ ...event, payload: { inputMode: 'browser_asr', asrOk: false } });
  assert.equal((await service.summary()).speechAttempts, 1);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'learning-events.jsonl'), 'utf8')).includes('Alice'));
});

test('20 fixed offline cases and mocked tool-selection cases are integration checks, not a live blind test', async () => {
  for (const mode of ['offline', 'mock-tool-selection']) {
    const report = await evaluate(mode);
    assert.equal(report.total, 20); assert.equal(report.passed, 20); assert.equal(report.answered, 19);
    assert.equal(report.liveModelTested, false); assert.equal(report.blindTest, false); assert.equal(report.paidCalls, 0);
  }
  await assert.rejects(() => evaluate('live'), /never runs a paid model/);
});
