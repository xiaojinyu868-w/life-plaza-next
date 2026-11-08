/** Fixed integration cases, NOT a blind test or a claim about any real model. No paid API calls. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanTurn, inferLookup, overLevel } from './canonical.mjs';
import { configuration, createServices } from './services.mjs';

export const CASES = [
  { id: 'fact-phev-engine', question: '插电式混合动力汽车有发动机吗？', contains: '有发动机', kind: 'fact' },
  { id: 'fact-bev-engine', question: '纯电动汽车有发动机吗？', contains: '没有发动机', kind: 'fact' },
  { id: 'fact-ice-motor', question: '燃油车有驱动电机吗？', contains: '没有驱动电机', kind: 'fact' },
  { id: 'fact-bev-fuel', question: '纯电动汽车消耗燃油吗？', contains: '不消耗燃油', kind: 'fact' },
  { id: 'fact-phev-battery', question: '插电式混合动力汽车有动力电池吗？', contains: '有动力电池', kind: 'fact' },
  { id: 'word-meaning', question: '驱动电机的英文怎么说？', contains: 'driving motor', kind: 'dictionary' },
  { id: 'word-pinyin', question: '发动机怎么读？', contains: 'fādòngjī', kind: 'dictionary' },
  { id: 'word-level', question: '动力电池是HSK几级？', contains: '动力电池', kind: 'dictionary' },
  { id: 'meaning-plug', question: '插电式是什么意思？', contains: '可以插电', kind: 'teaching' },
  { id: 'why-hybrid', question: '为什么叫混合动力汽车？', contains: '也有驱动电机', kind: 'teaching' },
  { id: 'grammar-ye', question: '也放在哪里？', contains: '动词前', kind: 'teaching' },
  { id: 'grammar-confirm', question: '对吗什么时候用？', contains: '对吗', meaning: 'confirm', kind: 'teaching' },
  { id: 'grammar-ne', question: '呢和对吗有什么区别？', contains: '问另一个', kind: 'teaching' },
  { id: 'evidence-example', question: '给也一个例句。', contains: '我朋友也是', kind: 'snapshot-excerpt', evidence: 'vd-ye' },
  { id: 'evidence-collocation', question: '动力电池还有什么搭配？', contains: '动力电池系统', kind: 'snapshot-excerpt', evidence: 'fq-dlc-tb' },
  { id: 'character-transfer', question: '带电字还有什么词？', contains: '电话', kind: 'hsk-chain' },
  { id: 'learner-agency', question: '我很紧张，不敢说中文。', contains: '慢慢说', kind: 'teaching' },
  { id: 'scaffolding', question: '请说慢一点。', contains: '先说一个词', kind: 'teaching' },
  { id: 'lesson-goal', question: '今天学什么？', contains: '也', kind: 'teaching' },
  { id: 'unsupported-parameter', question: '这个发动机有多少马力？', redirect: true },
];

export async function evaluate(mode = 'offline') {
  if (!['offline', 'mock-tool-selection'].includes(mode)) throw new Error('Only offline or mock-tool-selection are supported. This script never runs a paid model.');
  const config = configuration({});
  let selected;
  if (mode === 'mock-tool-selection') Object.assign(config, { llmUrl: 'https://test.invalid/chat/completions', llmKey: 'test-only', llmModel: 'not-a-real-model', llmSessionLimit: 100 });
  const service = createServices(config, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selected ? { intent: 'answer', lookup: selected, zh: '此文本由服务端丢弃。', seal: false } : { intent: 'redirect', zh: '我们一起看。', evidence: [], seal: false }) } }] })) });
  const rows = [];
  for (const item of CASES) {
    const turn = { sessionId: 's_fixed_evaluation_20261108', lesson: 'nev-l4', station: 'a', step: 'free-question', role: 'wang', level: 2, plugged: true, userText: item.question };
    selected = inferLookup(cleanTurn(turn));
    const result = await service.npc(turn);
    const passed = item.redirect ? result.intent === 'redirect' : result.intent === 'answer' && result.zh.includes(item.contains) && (!item.meaning || result.en.includes(item.meaning)) && result.grounding?.kind === item.kind && (!item.evidence || result.evidence.includes(item.evidence));
    assert.equal(result.seal, false);
    assert.deepEqual(result.overLevel, overLevel(result.zh, turn.level));
    rows.push({ id: item.id, passed, source: result.source, intent: result.intent, zh: result.zh, grounding: result.grounding?.kind || null, evidence: result.evidence, fallbackReason: result.fallbackReason || null });
  }
  return { kind: 'fixed-integration-evaluation', mode, liveModelTested: false, blindTest: false, paidCalls: 0, total: rows.length, passed: rows.filter((r) => r.passed).length, answered: rows.filter((r) => r.intent === 'answer').length, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2] || 'offline';
  const report = await evaluate(mode);
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}
