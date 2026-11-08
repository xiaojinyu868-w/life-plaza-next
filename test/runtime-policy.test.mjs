import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequestLimiter, privacyNotice, validateHosting } from '../server/runtime-policy.mjs';
import { configuration } from '../server/services.mjs';
import { createApp } from '../server/index.mjs';

test('30 learners behind one IP receive independent request windows', () => {
  let at = 1000;
  const limit = createRequestLimiter({ now: () => at });
  for (let turn = 0; turn < 180; turn++) for (let learner = 0; learner < 30; learner++) {
    assert.equal(limit.ip('shared-classroom').ok, true);
    assert.equal(limit.session('learner-' + learner).ok, true);
  }
  assert.equal(limit.session('learner-0').code, 'session_rate_limit');
  assert.equal(limit.session('new-learner').ok, true);
  for (let n = 0; n < 600; n++) assert.equal(limit.ip('shared-classroom').ok, true);
  assert.equal(limit.ip('shared-classroom').code, 'request_rate_limit');
  at += 60000;
  assert.equal(limit.session('learner-0').ok, true);
  assert.equal(limit.ip('shared-classroom').ok, true);
});

test('rate windows are bounded, reusable after expiry and recover from a clock rewind', () => {
  let at = 0;
  const limit = createRequestLimiter({ now: () => at, maxEntries: 2, sessionLimit: 1 });
  assert.equal(limit.session('a').ok, true); assert.equal(limit.session('b').ok, true);
  assert.equal(limit.session('c').code, 'rate_limit_capacity');
  at = 59999; assert.equal(limit.session('a').retryAfter, 1);
  at = 60000; assert.equal(limit.session('c').ok, true);
  assert.equal(limit.session('c').ok, false);
  at = 0; assert.equal(limit.session('c').ok, true);
});

test('public cloud speech needs the operator, both active vendors and their data notices', () => {
  const env = {
    WORKSHOP_PUBLIC_ORIGIN: 'https://class.example.test', WORKSHOP_OPERATOR_NAME: '示例学校',
    WORKSHOP_ASR_PROVIDER_NAME: '测试识别服务', WORKSHOP_ASR_REGION: '测试地域',
    WORKSHOP_ASR_AUDIO_RETENTION: '测试说明，不代表真实供应商', WORKSHOP_ASR_POLICY_URL: 'https://example.test/asr-policy',
  };
  const caps = { asr: true, assessment: true, assessmentVendor: 'tencent-soe' };
  const partial = configuration(env);
  assert.throws(() => validateHosting(partial, caps), /speech_disclosure_required/);
  assert.doesNotThrow(() => validateHosting(partial, { asr: true, assessment: false }));
  const complete = configuration({ ...env, WORKSHOP_ASSESSMENT_REGION: '另一个测试地域', WORKSHOP_ASSESSMENT_AUDIO_RETENTION: '测试评测说明', WORKSHOP_ASSESSMENT_POLICY_URL: 'https://example.test/assessment-policy' });
  assert.doesNotThrow(() => validateHosting(complete, caps));
  const notice = privacyNotice(complete, caps);
  assert.equal(notice.speech.providers.length, 2);
  assert.equal(notice.speech.providers[0].name, '腾讯云语音评测（SOE）');
  assert.equal(notice.events.retentionDays, 30);
  assert.doesNotThrow(() => validateHosting(configuration({}), caps), 'local tests may show incomplete information explicitly');
  assert.doesNotThrow(() => validateHosting(configuration({ WORKSHOP_PUBLIC_ORIGIN: env.WORKSHOP_PUBLIC_ORIGIN }), {}));
});

test('public policy URLs and origin must not carry credentials or executable schemes', () => {
  for (const url of ['javascript:alert(1)', 'http://example.test/policy', 'https://user:secret@example.test', 'https://example.test/?key=secret', 'not a url']) {
    assert.throws(() => configuration({ WORKSHOP_ASR_POLICY_URL: url }), /invalid_privacy_policy_url/);
  }
  for (const publicOrigin of ['https://user:secret@example.test', 'https://example.test/route', 'https://example.test?token=secret', 'garbage']) {
    assert.throws(() => validateHosting({ publicOrigin }, {}), /invalid_public_origin/);
  }
  assert.equal(configuration({ WORKSHOP_EVENT_RETENTION_DAYS: '0' }).eventRetentionDays, 0);
  assert.equal(configuration({ WORKSHOP_TENCENT_SCORE_COEFF: '2.5' }).tencentSoe.scoreCoeff, 2.5);
  assert.throws(() => configuration({ WORKSHOP_EVENT_RETENTION_DAYS: 'abc' }), /invalid_numeric_configuration/);
});

async function app(t, extra = {}) {
  let at = 1000;
  const { server } = createApp({ config: { ...configuration({}), ...extra }, now: () => at });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, nextMinute: () => { at += 60000; } };
}
const base = { sessionId: 's_rate_limit_123456', lesson: 'nev-l4', station: 'c', step: 'dragon-why', role: 'dragon', level: 2, plugged: true, userText: '为什么？' };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP session limiting blocks only the busy learner and resets without a server restart', async t => {
  const server = await app(t, { sessionRequestsPerMinute: 3 });
  for (let n = 0; n < 3; n++) assert.equal((await post(server.url + '/api/npc/turn', base)).status, 200);
  const limited = await post(server.url + '/api/npc/turn', base);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await limited.json()).error, 'session_rate_limit');
  assert.equal((await post(server.url + '/api/npc/turn', { ...base, sessionId: 's_another_learner_123' })).status, 200);
  assert.equal((await post(server.url + '/api/npc/turn', { ...base, sessionId: 'invalid' })).status, 400);
  server.nextMinute(); assert.equal((await post(server.url + '/api/npc/turn', base)).status, 200);
});

test('HTTP IP limiting includes status and does not trust spoofed forwarding headers', async t => {
  const server = await app(t, { ipRequestsPerMinute: 2 });
  for (let n = 0; n < 2; n++) assert.equal((await fetch(server.url + '/api/status')).status, 200);
  const result = await fetch(server.url + '/api/status', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(result.status, 429); assert.equal((await result.json()).error, 'request_rate_limit');
});

test('status exposes only the public notice, never credentials, provider endpoints or data paths', async t => {
  const server = await app(t, { asrUrl: 'https://private-service.example.test/transcriptions', asrKey: 'key-must-not-leak', asrModel: 'private-model-id', teacherToken: 'teacher-must-not-leak', eventRetentionDays: 0 });
  const raw = await (await fetch(server.url + '/api/status')).text(), response = JSON.parse(raw);
  assert.equal(response.privacy.speech.complete, false);
  assert.equal(response.privacy.events.enabled, false); assert.equal(response.capabilities.events, false);
  for (const value of ['private-service', 'key-must-not-leak', 'teacher-must-not-leak', 'private-model-id', 'dataDir']) assert.ok(!raw.includes(value));
});
