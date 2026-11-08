import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, cleanTurn, overLevel, ERROR_SAMPLES } from './canonical.mjs';
import { configuration, createServices } from './services.mjs';

export const DATASET_PATH = path.join(ROOT, 'content/evaluations/npc-50.json');
export const DEFAULT_SEED = 'workshop-preregistered-20261108-v1';
const FLAGS = ['factSafe', 'levelAppropriate', 'errorProvenanceValid', 'sealSafe', 'roleAndPedagogy'];
const phases = new Set(['request', 'response', 'validation', 'finish']);
const code = (text) => typeof text === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(text) ? text : null;
const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000000 ? n : null;
const ms = (n) => Number.isFinite(n) && n >= 0 && n <= 86400000 ? n : null;
const fail = (reason) => { throw new Error(reason); };
export const stableJson = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export async function loadDataset(file = DATASET_PATH) {
  const bytes = await fs.readFile(file);
  if (bytes.length > 500000) fail('dataset_too_large');
  const data = JSON.parse(bytes.toString('utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.cases) || data.cases.length !== 50) fail('dataset_requires_50_cases');
  const seen = new Set();
  for (const item of data.cases) {
    if (!/^npc-\d{2}$/.test(item.id) || seen.has(item.id) || !Array.isArray(item.tags) || !item.tags.length || typeof item.expectation !== 'string' || !item.expectation || typeof item.a02Eligible !== 'boolean') fail('invalid_case');
    if (item.dependsOn && !seen.has(item.dependsOn)) fail('invalid_case_dependency');
    if (item.clientExtras && Object.keys(item.clientExtras).some((k) => !['correct', 'answer', 'facts', 'allowedErrors'].includes(k))) fail('invalid_client_fixture');
    cleanTurn({ ...data.defaults, ...item, ...item.clientExtras, sessionId: 's_evaluation_schema_check' });
    seen.add(item.id);
  }
  if (data.cases.filter((c) => c.a02Eligible && c.role === 'wang' && !c.dependsOn).length < 20) fail('insufficient_question_pool');
  return { data, datasetSha256: sha256(bytes) };
}

/** Deterministic hash ordering avoids implementation-specific PRNG/shuffle behavior. */
export function sampleQuestions(cases, seed, size = 20) {
  if (typeof seed !== 'string' || !seed || seed.length > 160) fail('invalid_seed');
  const eligible = cases.filter((c) => c.a02Eligible && c.role === 'wang' && !c.dependsOn);
  if (!Number.isInteger(size) || size < 1 || size > eligible.length) fail('invalid_sample_size');
  return eligible.map((c) => ({ id: c.id, key: sha256(`${seed}\0${c.id}`) })).sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id)).slice(0, size).map((x) => x.id);
}

export function validatePrices(value) {
  if (value == null) return null;
  if (value.unit !== 'per_1000000_tokens' || !/^[A-Z]{3}$/.test(value.currency || '') || ![value.inputPerMillion, value.outputPerMillion].every((v) => Number.isFinite(v) && v >= 0 && v <= 1000000)) fail('invalid_prices');
  return { currency: value.currency, unit: value.unit, inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion, basis: 'operator-supplied-excludes-discounts-and-other-services' };
}
export function createPlan(dataset, { seed = DEFAULT_SEED, subset = 'all', prices = null, lessonTurns = 20 } = {}) {
  if (!['all', 'questions20'].includes(subset) || !Number.isInteger(lessonTurns) || lessonTurns < 1 || lessonTurns > 100) fail('invalid_plan');
  const sampledQuestionIds = sampleQuestions(dataset.data.cases, seed);
  return { schemaVersion: 1, datasetId: dataset.data.id, datasetSha256: dataset.datasetSha256, seed, samplingAlgorithm: 'sha256(seed+NUL+caseId)-ascending-v1', subset,
    sampledQuestionIds, orderedCaseIds: subset === 'all' ? dataset.data.cases.map((c) => c.id) : sampledQuestionIds,
    prices: validatePrices(prices), lessonTurns, targets: { answeredOf20: 16, auditedRounds: 50, firstTokenMs: 1500, completeSentenceMs: 3000 } };
}
export function verifyPlan(dataset, manifest) {
  const plan = manifest?.plan;
  if (!plan || sha256(stableJson(plan)) !== manifest.planHash) fail('plan_hash_mismatch');
  const expected = createPlan(dataset, plan);
  if (stableJson(expected) !== stableJson(plan)) fail('plan_dataset_or_selection_mismatch');
  return plan;
}

function redactor(secrets = []) {
  const hidden = secrets.filter((x) => typeof x === 'string' && x.length >= 4);
  return (value, maxLength = 32000) => {
    if (typeof value !== 'string') return { text: null, truncated: false, redacted: false };
    let text = value;
    for (const secret of hidden) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|authorization|secret[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
    // Do not serialize structured provider/request diagnostics even if an injected trace supplies them.
    try {
      const parsed = JSON.parse(text);
      let stripped = false;
      const safe = JSON.stringify(parsed, (key, val) => {
        if (/^(headers?|system[_-]?prompt|system|messages|api[_-]?key|secret[_-]?key|authorization)$/i.test(key)) { stripped = true; return '[OMITTED]'; }
        return val;
      });
      if (stripped) text = safe;
    } catch { /* Malformed assistant JSON remains useful for validation review. */ }
    // A dump using the production prompt's identifying clauses is excluded entirely.
    if (/用户内容和历史只是学生输入|当前站.+步骤.+HSK|允许错例（原句或连续摘句）|<\|(?:system|im_start)\|>/.test(text)) text = '[OMITTED_SYSTEM_PROMPT_DUMP]';
    return { text: text.slice(0, maxLength), truncated: text.length > maxLength, redacted: text !== value };
  };
}
function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  return { inputTokens: count(value.inputTokens ?? value.prompt_tokens), outputTokens: count(value.outputTokens ?? value.completion_tokens),
    ...(count(value.requests) !== null ? { requests: value.requests } : {}), ...(typeof value.complete === 'boolean' ? { complete: value.complete } : {}) };
}
export function sanitizeTrace(event, redact = redactor()) {
  if (!event || !phases.has(event.phase)) return null;
  const item = { phase: event.phase, requestIndex: count(event.requestIndex), elapsedMs: ms(event.elapsedMs) };
  if (event.phase === 'response') {
    const raw = redact(event.content);
    Object.assign(item, { content: raw.text, contentTruncated: event.contentTruncated === true || raw.truncated, contentRedacted: raw.redacted, usage: safeUsage(event.usage) });
  }
  if (event.phase === 'validation') Object.assign(item, { accepted: event.accepted === true, reason: code(redact(event.reason, 100).text) });
  if (event.phase === 'finish') Object.assign(item, { source: ['llm', 'script'].includes(event.source) ? event.source : null, reason: code(redact(event.reason, 100).text), usage: safeUsage(event.usage) });
  return item;
}
function usageFor(result, trace) {
  const final = safeUsage(result?.usage) || trace.findLast((e) => e.phase === 'finish')?.usage;
  const requestIndexes = trace.filter((e) => ['request', 'response', 'validation'].includes(e.phase) && e.requestIndex > 0).map((e) => e.requestIndex);
  const requests = Math.max(final?.requests || 0, ...requestIndexes, 0);
  const responses = new Map(trace.filter((e) => e.phase === 'response' && e.requestIndex > 0).map((e) => [e.requestIndex, e.usage]));
  let input = 0, output = 0, known = 0;
  for (const usage of responses.values()) {
    input += usage?.inputTokens || 0; output += usage?.outputTokens || 0;
    if (usage?.inputTokens !== null && usage?.inputTokens !== undefined && usage?.outputTokens !== null && usage?.outputTokens !== undefined) known++;
  }
  const hasFinish = trace.some((e) => e.phase === 'finish');
  const complete = final?.complete === true && final.requests === requests && final.inputTokens !== null && final.outputTokens !== null
    || requests > 0 && known === requests || requests === 0 && hasFinish && result?.source === 'script';
  return { inputTokens: Math.max(input, final?.inputTokens || 0), outputTokens: Math.max(output, final?.outputTokens || 0), requests: requests || (hasFinish ? 0 : null), complete: Boolean(complete), missingRequestUsage: requests ? Math.max(0, requests - known) : hasFinish ? 0 : null };
}
function finalOutput(result, redact) {
  return { ok: result?.ok === true, source: ['llm', 'script'].includes(result?.source) ? result.source : 'error', intent: code(result?.intent),
    zh: redact(result?.zh, 1000).text || '', en: redact(result?.en, 1000).text || '', teacher: redact(result?.teacher, 1000).text || '', seal: result?.seal === true,
    evidence: Array.isArray(result?.evidence) ? result.evidence.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 30) : [],
    overLevel: Array.isArray(result?.overLevel) ? result.overLevel.slice(0, 100).map((x) => ({ w: redact(x.w, 80).text, hsk: Number.isInteger(x.hsk) ? x.hsk : null, bands: Array.isArray(x.bands) ? x.bands.filter(b => ['1', '2', '3', '4', '5', '6', '7-9'].includes(b)) : [], ambiguous: x.ambiguous === true, professional: x.professional === true })) : [],
    fallbackReason: code(redact(result?.fallbackReason, 100).text), error: code(redact(result?.error, 100).text) };
}
function checks(body, final) {
  const turn = cleanTurn(body), expected = overLevel(final.zh, body.level, turn.content).map((x) => x.w).sort();
  const declared = final.overLevel.map((x) => x.w).sort();
  return { length: [...final.zh].filter((c) => /\p{Script=Han}/u.test(c)).length <= turn.maxChars,
    levelAnnotationsMatchBundledData: stableJson(expected) === stableJson(declared), sealFalse: final.seal === false,
    knownEvidence: final.evidence.every((id) => Object.hasOwn(turn.content.evidence, id)),
    errorQuoteTraceable: final.intent !== 'error_demo' || body.plugged && body.role === 'dragon' && ERROR_SAMPLES.some((e) => e.zh === final.zh && final.evidence.includes(e.id)),
    factQuality: 'teacher-required', uiOrangeRendering: 'not-measured' };
}

/** Dry run never constructs services. Injected transport is explicitly mock, never live acceptance. */
export async function runEvaluation({ dataset, plan = createPlan(dataset), mode = 'dry-run', config, serviceFactory, now = Date.now, runId = `npc-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, caseTimeoutMs = 3500, onManifest, onRow } = {}) {
  if (!['dry-run', 'mock', 'live'].includes(mode)) fail('invalid_run_mode');
  if (mode === 'live' && (serviceFactory || !config?.llmUrl || !config?.llmKey || !config?.llmModel)) fail('live_requires_complete_config_and_real_transport');
  if (mode === 'mock' && typeof serviceFactory !== 'function') fail('mock_requires_injected_service');
  if (!Number.isFinite(caseTimeoutMs) || caseTimeoutMs < 1 || caseTimeoutMs > 30000 || !/^[A-Za-z0-9_.-]{1,100}$/.test(runId)) fail('invalid_run_options');
  const verifiedPlan = verifyPlan(dataset, { plan, planHash: sha256(stableJson(plan)) });
  const redact = redactor([config?.llmKey, config?.llmUrl]);
  if ([config?.llmKey, config?.llmUrl].some((secret) => typeof secret === 'string' && secret.length >= 4 && stableJson(verifiedPlan).includes(secret))) fail('sensitive_plan_value');
  const sourceFiles = ['server/npc-evaluation.mjs', 'server/services.mjs', 'server/canonical.mjs', 'src/data.js', 'src/hsk.js', 'src/lexicon.js', 'content/hsk/vocabulary-2025.json', 'src/logic.js', 'src/script.js', 'src/lesson.js', 'content/lessons/nev-l4.json', 'content/lessons/nev-l5.json'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await fs.readFile(path.join(ROOT, file)))])));
  const manifest = { schemaVersion: 1, runId, mode, createdAt: new Date(now()).toISOString(), plan: verifiedPlan, planHash: sha256(stableJson(verifiedPlan)),
    model: mode === 'live' ? redact(String(config.llmModel), 160).text : mode === 'mock' ? 'injected-test-double' : null,
    liveRequested: mode === 'live', executionAtManifestCreation: 'not-started', blindTest: false, streaming: false, timingScope: 'server-service-not-browser-rendering', runtime: { node: process.version, sourceSha256: sourceHashes } };
  const manifestHash = sha256(stableJson(manifest));
  await onManifest?.(manifest); // Persist preregistration before the first provider request.
  const rows = [], byId = new Map(dataset.data.cases.map((item) => [item.id, item]));
  for (const id of plan.orderedCaseIds) {
    const item = byId.get(id), previous = item.dependsOn ? rows.find((row) => row.caseId === item.dependsOn) : null;
    const body = { ...dataset.data.defaults, ...item, ...item.clientExtras, sessionId: `s_eval_${sha256(runId + id).slice(0, 24)}` };
    if (previous) body.history = [{ who: 'you', zh: byId.get(item.dependsOn).userText }, { who: previous.role, zh: previous.final.zh }];
    const trace = []; let result, active = true, timer; const start = now();
    if (mode === 'dry-run') result = { ok: false, error: 'dry_run_not_executed' };
    else {
      const factory = serviceFactory || createServices;
      try {
        const service = factory(config || configuration({}), { onNpcTrace: (event) => { if (active && trace.length < 100) { const safe = sanitizeTrace(event, redact); if (safe) trace.push(safe); } } });
        result = await Promise.race([Promise.resolve().then(() => service.npc(body)), new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'evaluation_deadline' }), caseTimeoutMs); })]);
      } catch { result = { ok: false, error: 'evaluation_service_error' }; }
      finally { active = false; clearTimeout(timer); }
    }
    const final = finalOutput(result, redact), usage = mode === 'dry-run' ? null : usageFor(result, trace);
    const elapsedMs = mode === 'dry-run' ? null : Math.max(0, now() - start);
    const row = { caseId: id, role: body.role, level: body.level, station: body.station, lesson: body.lesson, question: item.userText, purpose: body.purpose,
      expectation: item.expectation, tags: item.tags, dependsOn: item.dependsOn || null, final, trace,
      rawCandidates: trace.filter((e) => e.phase === 'response').map((e) => ({ requestIndex: e.requestIndex, content: e.content, contentTruncated: e.contentTruncated, contentRedacted: e.contentRedacted })),
      retries: usage?.requests == null ? null : Math.max(0, usage.requests - 1), usage,
      timing: { elapsedMs, serviceMs: ms(result?.latencyMs), firstTokenMs: null, firstTokenStatus: 'not-streamed', modelReplyWithin3000Ms: final.source === 'llm' && elapsedMs <= 3000 },
      automaticChecks: mode === 'dry-run' ? null : checks(body, final),
      repetition: previous ? { previousCaseId: previous.caseId, identicalFinalText: previous.final.zh === final.zh, bothModelReplies: previous.final.source === 'llm' && final.source === 'llm' } : null };
    row.responseHash = sha256(stableJson(row)); rows.push(row); await onRow?.(row);
    if (mode === 'live' && result?.error === 'evaluation_deadline') break; // Do not stack paid work behind a hung service.
  }
  const report = { manifest, manifestHash, rows, responsesHash: sha256(stableJson(rows.map((r) => [r.caseId, r.responseHash]))) };
  return { ...report, summary: summarize(report), teacherReview: createReviewTemplate(report) };
}

export function createReviewTemplate(report) {
  return { schemaVersion: 1, runId: report.manifest.runId, manifestHash: report.manifestHash, responsesHash: report.responsesHash, reviewerId: '', reviewedAt: '',
    note: '由教师检查实际回复、原始候选和案例期望；不要用脚本兜底或仅通过程序校验代替模型质量。',
    reviews: report.rows.map((r) => ({ caseId: r.caseId, responseHash: r.responseHash, verdict: 'pending', answersQuestion: null, ...Object.fromEntries(FLAGS.map((f) => [f, null])), notes: '' })) };
}
function reviewMap(report, review) {
  if (!review) return new Map();
  if (review.schemaVersion !== 1 || review.runId !== report.manifest.runId || review.manifestHash !== report.manifestHash || review.responsesHash !== report.responsesHash || !Array.isArray(review.reviews)) fail('review_run_mismatch');
  const rows = new Map(report.rows.map((r) => [r.caseId, r])), result = new Map();
  for (const item of review.reviews) {
    if (!rows.has(item.caseId) || result.has(item.caseId) || item.responseHash !== rows.get(item.caseId).responseHash || !['pending', 'pass', 'fail'].includes(item.verdict)) fail('invalid_review_entry');
    if (item.verdict !== 'pending' && (!/^[A-Za-z0-9_-]{1,64}$/.test(review.reviewerId || '') || !Number.isFinite(Date.parse(review.reviewedAt)) || !FLAGS.every((f) => typeof item[f] === 'boolean') || typeof item.answersQuestion !== 'boolean')) fail('review_requires_explicit_teacher_decisions');
    if (item.verdict === 'pass' && !FLAGS.every((f) => item[f] === true)) fail('contradictory_review');
    result.set(item.caseId, item);
  }
  return result;
}
export function estimateCost(rows, prices, lessonTurns = 20, mode = 'live') {
  const quote = validatePrices(prices);
  if (mode === 'dry-run') return { status: 'not-run', currency: quote?.currency || null, amount: null, lowerBound: null, complete: false };
  const inputTokens = rows.reduce((s, r) => s + (r.usage?.inputTokens || 0), 0), outputTokens = rows.reduce((s, r) => s + (r.usage?.outputTokens || 0), 0);
  const complete = rows.length > 0 && rows.every((r) => r.usage?.complete === true);
  const lowerBound = quote ? (inputTokens * quote.inputPerMillion + outputTokens * quote.outputPerMillion) / 1000000 : null;
  return { status: !quote ? 'unknown-prices' : complete ? 'token-estimate-not-invoice' : 'lower-bound-incomplete', usageSource: mode === 'mock' ? 'injected-test-double' : 'reported-provider-usage', currency: quote?.currency || null,
    unit: quote?.unit || null, inputTokensKnown: inputTokens, outputTokensKnown: outputTokens, complete, amount: complete ? lowerBound : null, lowerBound,
    lessonScenario: quote && rows.length ? { turns: lessonTurns, amount: complete ? lowerBound / rows.length * lessonTurns : null, lowerBound: lowerBound / rows.length * lessonTurns, basis: 'same-turn-mix-as-this-evaluation-not-a-measured-class', excludes: ['speech', 'tts', 'hosting', 'tax', 'unknown-usage', 'provider-billing-adjustments'] } : null };
}
export function summarize(report, teacherReview) {
  const reviews = reviewMap(report, teacherReview), rows = report.rows, live = report.manifest.mode === 'live';
  const autoPass = (r) => r.automaticChecks && Object.values(r.automaticChecks).every((v) => typeof v !== 'boolean' || v);
  const modelReply = (r) => r.final.source === 'llm' && r.final.ok && r.trace.some((e) => e.phase === 'validation' && e.accepted) && r.rawCandidates.length > 0;
  const approved = (r) => live && modelReply(r) && autoPass(r) && reviews.get(r.caseId)?.verdict === 'pass';
  const sampleIds = report.manifest.plan.sampledQuestionIds, sample = sampleIds.map((id) => rows.find((r) => r.caseId === id));
  const reviewed20 = sample.every((r) => r && ['pass', 'fail'].includes(reviews.get(r.caseId)?.verdict));
  const answered = sample.filter((r) => r && approved(r) && reviews.get(r.caseId)?.answersQuestion === true).length;
  const full50 = report.manifest.plan.subset === 'all' && rows.length === 50 && rows.every(modelReply);
  const completeRaw = rows.every((r) => r.rawCandidates.length && r.rawCandidates.every((c) => c.content && !c.contentTruncated && !c.contentRedacted));
  const reviewed50 = rows.length === 50 && rows.every((r) => ['pass', 'fail'].includes(reviews.get(r.caseId)?.verdict));
  return { mode: report.manifest.mode, liveModelTested: live && rows.some((r) => r.rawCandidates.length > 0), blindTest: false, expectedRounds: report.manifest.plan.orderedCaseIds.length, observedRounds: report.manifest.mode === 'dry-run' ? 0 : rows.length, recordedCaseEntries: rows.length,
    deliveredModelReplies: rows.filter(modelReply).length, scriptFallbacks: rows.filter((r) => r.final.source === 'script').length,
    providerRequests: report.manifest.mode === 'dry-run' ? 0 : rows.some((r) => r.usage?.requests == null) ? null : rows.reduce((s, r) => s + r.usage.requests, 0),
    rawCandidates: rows.reduce((s, r) => s + r.rawCandidates.length, 0), rawTruncated: rows.filter((r) => r.rawCandidates.some((c) => c.contentTruncated)).length, rawRedacted: rows.filter((r) => r.rawCandidates.some((c) => c.contentRedacted)).length,
    teacherReviewed: reviews.size ? rows.filter((r) => ['pass', 'fail'].includes(reviews.get(r.caseId)?.verdict)).length : 0,
    A02: { status: !live ? 'not-live' : !reviewed20 ? 'pending-teacher-review' : answered >= 16 ? 'pass' : 'fail', answered, required: 16, sampleSize: 20, denominatorIncludesFallbacks: true },
    A05to08: { status: !live ? 'not-live' : !full50 ? 'incomplete-model-sample' : !completeRaw ? 'incomplete-raw-sample' : !reviewed50 ? 'pending-teacher-review' : rows.every(approved) ? 'pass-content-only' : 'fail', requestedModelRounds: 50, uiOrangeRendering: 'requires-browser-verification' },
    A12: { status: 'not-measured-end-to-end', firstTokenMs: null, firstTokenStatus: 'not-streamed', firstTokenTargetMs: 1500, sentenceTargetMs: 3000,
      serverRepliesWithinTarget: rows.filter((r) => modelReply(r) && r.timing.modelReplyWithin3000Ms).length, timingScope: report.manifest.timingScope },
    A13: estimateCost(rows, report.manifest.plan.prices, report.manifest.plan.lessonTurns, report.manifest.mode) };
}

export function liveConfiguration(env) {
  if (!['WORKSHOP_LLM_URL', 'WORKSHOP_LLM_API_KEY', 'WORKSHOP_LLM_MODEL'].every((k) => typeof env[k] === 'string' && env[k].trim())) fail('live_requires_WORKSHOP_LLM_URL_API_KEY_MODEL');
  try { return configuration(Object.fromEntries(['WORKSHOP_LLM_URL', 'WORKSHOP_LLM_API_KEY', 'WORKSHOP_LLM_MODEL'].map((k) => [k, env[k]]))); }
  catch { fail('invalid_live_configuration'); }
}
async function readJson(file) { const data = await fs.readFile(file, 'utf8'); if (data.length > 20000000) fail('report_file_too_large'); return JSON.parse(data); }
export function parseArgs(args) {
  const options = {}, valued = new Set(['--seed', '--subset', '--out', '--manifest', '--review', '--report-dir', '--currency', '--input-per-million', '--output-per-million', '--lesson-turns']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (Object.hasOwn(options, key)) fail('duplicate_option');
    if (['--live', '--dry-run', '--help'].includes(key)) options[key] = true;
    else if (valued.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else fail('invalid_cli_option');
  }
  if (options['--live'] && options['--dry-run'] || options['--review'] && (options['--live'] || !options['--report-dir'])) fail('conflicting_cli_modes');
  return options;
}
export async function cli(args = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(args);
  if (opts['--help']) { console.log('Default: dry run. --live requires WORKSHOP_LLM_URL/API_KEY/MODEL. Options: --seed --subset all|questions20 --manifest --out --currency --input-per-million --output-per-million --lesson-turns. Review offline: --review FILE --report-dir DIR.'); return; }
  if (opts['--review']) {
    const folder = path.resolve(opts['--report-dir']), manifest = await readJson(path.join(folder, 'manifest.json'));
    const rows = (await fs.readFile(path.join(folder, 'results.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const row of rows) { const { responseHash, ...payload } = row; if (responseHash !== sha256(stableJson(payload))) fail('report_response_hash_mismatch'); }
    const report = { manifest, rows, manifestHash: sha256(stableJson(manifest)), responsesHash: sha256(stableJson(rows.map((r) => [r.caseId, r.responseHash]))) };
    const summary = summarize(report, await readJson(opts['--review']));
    await fs.writeFile(path.join(folder, 'reviewed-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2)); return;
  }
  if (opts['--report-dir']) fail('report_dir_requires_review');
  const dataset = await loadDataset(); let plan;
  if (opts['--manifest']) {
    if (['--seed', '--subset', '--currency', '--input-per-million', '--output-per-million', '--lesson-turns'].some((k) => opts[k] !== undefined)) fail('manifest_overrides_not_allowed');
    plan = verifyPlan(dataset, await readJson(opts['--manifest']));
  } else {
    const priced = ['--currency', '--input-per-million', '--output-per-million'].some((k) => opts[k] !== undefined);
    const prices = priced ? { unit: 'per_1000000_tokens', currency: opts['--currency'], inputPerMillion: Number(opts['--input-per-million']), outputPerMillion: Number(opts['--output-per-million']) } : null;
    plan = createPlan(dataset, { seed: opts['--seed'] || DEFAULT_SEED, subset: opts['--subset'] || 'all', prices, lessonTurns: opts['--lesson-turns'] ? Number(opts['--lesson-turns']) : 20 });
  }
  const config = opts['--live'] ? liveConfiguration(env) : undefined;
  const root = path.resolve(opts['--out'] || path.join(ROOT, '.local/evaluations')); let folder;
  const report = await runEvaluation({ dataset, plan, mode: opts['--live'] ? 'live' : 'dry-run', config,
    onManifest: async (manifest) => {
      await fs.mkdir(root, { recursive: true }); folder = path.join(root, manifest.runId); await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(folder, 'results.jsonl'), '', { flag: 'wx', mode: 0o600 });
    },
    onRow: async (row) => fs.appendFile(path.join(folder, 'results.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }),
  });
  await fs.writeFile(path.join(folder, 'summary.json'), JSON.stringify(report.summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(folder, 'teacher-review.template.json'), JSON.stringify(report.teacherReview, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ directory: folder, ...report.summary }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch((error) => { console.error(code(error.message) || 'evaluation_failed'); process.exitCode = 1; });
