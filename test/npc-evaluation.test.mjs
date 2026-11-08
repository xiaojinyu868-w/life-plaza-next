import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServices, configuration } from '../server/services.mjs';
import { overLevel } from '../server/canonical.mjs';
import { loadDataset, sampleQuestions, createPlan, verifyPlan, runEvaluation, summarize, createReviewTemplate, estimateCost, sanitizeTrace, liveConfiguration, parseArgs, sha256, stableJson, cli } from '../server/npc-evaluation.mjs';

const dataset = await loadDataset();
const prices = { currency: 'CNY', unit: 'per_1000000_tokens', inputPerMillion: 1, outputPerMillion: 2 };
const factory = (_config, { onNpcTrace }) => ({ npc: async (body) => {
  onNpcTrace({ phase: 'request', requestIndex: 1, elapsedMs: 0 });
  onNpcTrace({ phase: 'response', requestIndex: 1, elapsedMs: 12, content: '{"intent":"ask_back","zh":"你呢？","seal":false}', usage: { inputTokens: 100, outputTokens: 10 } });
  onNpcTrace({ phase: 'validation', requestIndex: 1, elapsedMs: 13, accepted: true });
  onNpcTrace({ phase: 'finish', requestIndex: 1, elapsedMs: 14, source: 'llm', usage: { inputTokens: 100, outputTokens: 10, requests: 1, complete: true } });
  return { ok: true, source: 'llm', intent: 'ask_back', zh: '你呢？', seal: false, evidence: [], overLevel: overLevel('你呢？', body.level), latencyMs: 14 };
} });
async function simulated(options = {}) {
  return runEvaluation({ dataset, plan: createPlan(dataset, { prices }), mode: 'mock', serviceFactory: factory, runId: 'test-run', now: () => 1700000000000, ...options });
}
// These synthetic report fixtures test aggregation only. No test makes a paid/live request.
function liveReportFixture(report) {
  const copy = structuredClone(report); copy.manifest.mode = 'live'; copy.manifest.liveModelTested = true;
  copy.manifestHash = sha256(stableJson(copy.manifest)); return copy;
}
function approvedReview(report) {
  const review = createReviewTemplate(report); review.reviewerId = 'teacher-fixture'; review.reviewedAt = '2026-11-08T00:00:00Z';
  for (const item of review.reviews) Object.assign(item, { verdict: 'pass', answersQuestion: true, factSafe: true, levelAppropriate: true, errorProvenanceValid: true, sealSafe: true, roleAndPedagogy: true });
  return review;
}

test('50 preregistered cases cover roles, levels, stations, attacks and server-checked repeated feedback', () => {
  assert.equal(dataset.data.cases.length, 50); assert.equal(new Set(dataset.data.cases.map((c) => c.id)).size, 50);
  for (const role of ['wang', 'dragon']) assert.ok(dataset.data.cases.some((c) => c.role === role));
  for (const level of [0, 1, 2, 3]) assert.ok(dataset.data.cases.some((c) => c.level === level));
  for (const tag of ['fact', 'grammar', 'unknown', 'evidence', 'injection', 'repeat', 'feedback']) assert.ok(dataset.data.cases.some((c) => c.tags.includes(tag)));
  assert.equal(dataset.data.cases.find((c) => c.id === 'npc-32').dependsOn, 'npc-31');
});

test('seed sampling and dataset/plan hashes are deterministic, detect tampering and include exactly 20 eligible questions', () => {
  const a = sampleQuestions(dataset.data.cases, 'fixed-seed'), b = sampleQuestions([...dataset.data.cases].reverse(), 'fixed-seed');
  assert.deepEqual(a, b); assert.equal(a.length, 20); assert.equal(new Set(a).size, 20);
  assert.notDeepEqual(a, sampleQuestions(dataset.data.cases, 'another-seed'));
  const plan = createPlan(dataset, { seed: 'fixed-seed', prices });
  assert.deepEqual(verifyPlan(dataset, { plan, planHash: sha256(stableJson(plan)) }), plan);
  assert.throws(() => verifyPlan(dataset, { plan: { ...plan, seed: 'modified' }, planHash: sha256(stableJson(plan)) }), /hash_mismatch/);
  const tampered = { ...plan, sampledQuestionIds: [...plan.sampledQuestionIds].reverse() };
  assert.throws(() => verifyPlan(dataset, { plan: tampered, planHash: sha256(stableJson(tampered)) }), /selection_mismatch/);
});

test('dry run never constructs a service or reads implicit provider settings and records zero executed rounds', async () => {
  let called = false;
  const report = await runEvaluation({ dataset, serviceFactory: () => { called = true; throw new Error('network forbidden'); } });
  assert.equal(called, false); assert.equal(report.summary.observedRounds, 0); assert.equal(report.summary.providerRequests, 0);
  assert.equal(report.rows.length, 50); assert.equal(report.summary.A13.amount, null); assert.equal(report.summary.A02.status, 'not-live');
  assert.ok(report.teacherReview.reviews.every((r) => r.verdict === 'pending'));
  assert.throws(() => liveConfiguration({ DASHSCOPE_API_KEY: 'never-use-implicitly' }), /WORKSHOP/);
  assert.throws(() => liveConfiguration({ WORKSHOP_LLM_URL: 'https://example.test', WORKSHOP_LLM_MODEL: 'test' }), /WORKSHOP/);
  await assert.rejects(() => runEvaluation({ dataset, mode: 'live', config: { llmUrl: 'https://test.invalid', llmKey: 'test', llmModel: 'test' }, serviceFactory: factory }), /real_transport/);
});

test('preregistration callback precedes requests and repeated cases receive the preceding actual final reply', async () => {
  let registered = false; const bodies = [];
  const report = await simulated({ onManifest: () => { registered = true; }, serviceFactory: (config, deps) => {
    const service = factory(config, deps); return { npc: (body) => { assert.ok(registered); bodies.push(body); return service.npc(body); } };
  } });
  const second = bodies.find((b) => b.id === 'npc-32');
  assert.equal(second.history[0].zh, '驱动电机'); assert.equal(second.history[1].zh, '你呢？');
  assert.equal(report.rows.find((r) => r.caseId === 'npc-32').repetition.identicalFinalText, true);
  assert.equal(new Set(bodies.map((b) => b.sessionId)).size, 50);
});

test('real service trace integration with injected fetch preserves raw candidates and usage, labelled mock', async () => {
  let calls = 0;
  const config = { ...configuration({}), llmUrl: 'https://example.test/chat/completions', llmKey: 'test-only', llmModel: 'fake' };
  const report = await simulated({ config, plan: createPlan(dataset, { subset: 'questions20' }), serviceFactory: (config, deps) => createServices(config, {
    ...deps, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"ask_back","zh":"你呢？","seal":false}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } })); },
  }) });
  assert.equal(calls, 20); assert.equal(report.rows[0].rawCandidates.length, 1); assert.equal(report.rows[0].usage.complete, true);
  assert.equal(report.summary.liveModelTested, false); assert.equal(report.summary.A02.status, 'not-live');
});

test('raw trace truncation, retry events and incomplete usage remain visible without headers, secrets or prompt persistence', async () => {
  const report = await simulated({ config: { llmKey: 'secret-fixture-123', llmUrl: 'https://secret-fixture.test' }, serviceFactory: (_c, { onNpcTrace }) => ({ npc: async (body) => {
    onNpcTrace({ phase: 'request', requestIndex: 1, elapsedMs: 0, headers: { Authorization: 'secret-fixture-123' }, systemPrompt: 'private system' });
    onNpcTrace({ phase: 'response', requestIndex: 1, elapsedMs: 10, content: '{"zh":"secret-fixture-123","headers":{"Authorization":"hidden"}}', contentTruncated: true, usage: null });
    onNpcTrace({ phase: 'validation', requestIndex: 1, elapsedMs: 11, accepted: false, reason: 'too_long' });
    onNpcTrace({ phase: 'request', requestIndex: 2, elapsedMs: 12 });
    onNpcTrace({ phase: 'response', requestIndex: 2, elapsedMs: 20, content: '{"zh":"你呢？"}', usage: { inputTokens: 100, outputTokens: 10 } });
    onNpcTrace({ phase: 'validation', requestIndex: 2, elapsedMs: 21, accepted: true });
    onNpcTrace({ phase: 'finish', requestIndex: 2, elapsedMs: 22, source: 'llm', usage: { inputTokens: 100, outputTokens: 10, requests: 2, complete: false } });
    return { ok: true, source: 'llm', zh: '你呢？', seal: false, evidence: [], overLevel: overLevel('你呢？', body.level) };
  } }) });
  const row = report.rows[0]; assert.equal(row.retries, 1); assert.equal(row.rawCandidates[0].contentTruncated, true); assert.equal(row.usage.complete, false);
  assert.ok(!JSON.stringify(report).includes('secret-fixture-123')); assert.ok(!JSON.stringify(report).includes('private system')); assert.ok(!JSON.stringify(report).includes('hidden'));
  assert.equal(report.summary.A13.amount, null); assert.ok(report.summary.A13.lowerBound > 0); assert.equal(report.summary.A13.status, 'lower-bound-incomplete');
  assert.equal(sanitizeTrace({ phase: 'token', firstTokenMs: 7 }), null);
});

test('all teacher decisions default pending; explicit review is bound to this run and response hashes', async () => {
  const live = liveReportFixture(await simulated());
  assert.equal(summarize(live).A02.status, 'pending-teacher-review');
  const review = approvedReview(live); assert.equal(summarize(live, review).A02.status, 'pass');
  assert.equal(summarize(live, review).A05to08.status, 'pass-content-only');
  assert.throws(() => summarize(live, { ...review, responsesHash: 'wrong' }), /mismatch/);
  const missing = structuredClone(review); missing.reviews[0].factSafe = null;
  assert.throws(() => summarize(live, missing), /explicit_teacher/);
  const falsePass = structuredClone(review); falsePass.reviews[0].sealSafe = false;
  assert.throws(() => summarize(live, falsePass), /contradictory/);
  assert.throws(() => summarize(live, { ...review, reviewerId: '' }), /explicit_teacher/);
});

test('script fallback never counts toward 16 of 20, even when a teacher accepts its teaching text', async () => {
  const live = liveReportFixture(await simulated());
  const rejectedIds = live.manifest.plan.sampledQuestionIds.slice(0, 5);
  for (const row of live.rows) if (rejectedIds.includes(row.caseId)) { row.final.source = 'script'; row.final.fallbackReason = 'too_long'; }
  const summary = summarize(live, approvedReview(live));
  assert.equal(summary.A02.answered, 15); assert.equal(summary.A02.status, 'fail'); assert.equal(summary.scriptFallbacks, 5);
  assert.equal(summary.A05to08.status, 'incomplete-model-sample');
});

test('complete retry token usage is summed; missing usage gives a lower bound, never an asserted zero invoice', () => {
  const complete = estimateCost([{ usage: { inputTokens: 200, outputTokens: 20, requests: 2, complete: true } }], prices);
  assert.equal(complete.amount, 0.00024); assert.equal(complete.lessonScenario.amount, 0.0048000000000000004);
  const absent = estimateCost([{ usage: { inputTokens: 0, outputTokens: 0, requests: 1, complete: false } }], prices);
  assert.equal(absent.amount, null); assert.equal(absent.lowerBound, 0); assert.equal(absent.complete, false);
  assert.equal(estimateCost([{ usage: null }], null).status, 'unknown-prices');
  assert.throws(() => createPlan(dataset, { prices: { ...prices, currency: undefined } }), /invalid_prices/);
});

test('non-streaming cannot acquire a first-token result; slow replies and hard deadline are recorded separately', async () => {
  let time = 1700000000000;
  const slow = await simulated({ now: () => time, serviceFactory: (config, deps) => {
    const service = factory(config, deps); return { npc: async (body) => { const r = await service.npc(body); time += 3100; return r; } };
  } });
  assert.ok(slow.rows.every((r) => r.timing.firstTokenMs === null && r.timing.modelReplyWithin3000Ms === false));
  const hung = await simulated({ plan: createPlan(dataset, { subset: 'questions20', prices }), caseTimeoutMs: 3, serviceFactory: (_c, { onNpcTrace }) => ({ npc: () => {
    onNpcTrace({ phase: 'request', requestIndex: 1, elapsedMs: 0 }); return new Promise(() => {});
  } }) });
  assert.ok(hung.rows.every((r) => r.final.error === 'evaluation_deadline' && r.usage.complete === false));
  assert.equal(hung.summary.A13.amount, null); assert.equal(hung.summary.A12.firstTokenMs, null);
});

test('CLI defaults dry-run, rejects ambiguous live/review switches, and writes only controlled local artifacts', async (t) => {
  assert.equal(parseArgs([])['--live'], undefined); assert.throws(() => parseArgs(['--live', '--dry-run']), /conflicting/);
  assert.throws(() => parseArgs(['--review', 'x.json', '--report-dir', 'x', '--live']), /conflicting/);
  assert.throws(() => parseArgs(['--api-key', 'never-accept-secret-in-cli']), /invalid_cli/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npc-evaluation-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = console.log; console.log = () => {};
  try { await cli(['--out', dir], { DASHSCOPE_API_KEY: 'not-used' }); } finally { console.log = log; }
  const [run] = await fs.readdir(dir), files = await fs.readdir(path.join(dir, run));
  assert.deepEqual(files.sort(), ['manifest.json', 'results.jsonl', 'summary.json', 'teacher-review.template.json'].sort());
  const summary = JSON.parse(await fs.readFile(path.join(dir, run, 'summary.json'), 'utf8'));
  assert.equal(summary.observedRounds, 0); assert.equal(summary.A13.amount, null);
});
