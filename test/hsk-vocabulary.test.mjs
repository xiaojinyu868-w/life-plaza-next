import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LEXICON, ROOT, overLevel, readLesson, cleanTurn, fallbackTurn, renderLookup, inferLookup, validateNpc } from '../server/canonical.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../content/hsk/vocabulary-2025.json', import.meta.url), 'utf8'));
const l4 = readLesson('nev-l4'), l5 = readLesson('nev-l5');
const base = { sessionId: 's_lexicon_test123456', lesson: 'nev-l4', role: 'wang', station: 'c', level: 2, plugged: false, userText: '也放在哪里？' };

test('complete pinned word projection retains every official serial and additional usage band', () => {
  assert.equal(data.words.length, 10896);
  assert.equal(new Set(data.words.map(x => x.word)).size, 10896);
  const records = data.words.flatMap(x => x.records);
  assert.equal(records.length, 11000);
  assert.deepEqual(records.map(r => r.serial).sort((a, b) => a - b), Array.from({ length: 11000 }, (_, i) => i + 1));
  const counts = Object.fromEntries(['1','2','3','4','5','6','7-9'].map(b => [b, records.filter(r => r.band === b).length]));
  assert.deepEqual(counts, { '1': 300, '2': 200, '3': 500, '4': 1000, '5': 1600, '6': 1800, '7-9': 5600 });
  assert.equal(records.filter(r => r.usageBands.length).length, 102);
  assert.equal(data.words.filter(x => x.records.length > 1).length, 99);
  assert.ok(data.words.every(x => x.readings.length && x.meanings.length));
  assert.ok(records.every(r => !r.usageBands.includes(r.band)));
});

test('official word grades replace character grades and preserve mixed-use uncertainty', () => {
  for (const [word, band] of [['认','5'], ['识','6'], ['认识','1'], ['前','1'], ['句子','3'], ['明白','3'], ['燃油','7-9']]) assert.equal(LEXICON.entry(word).band, band, word);
  assert.equal(LEXICON.entry('机'), null); assert.equal(LEXICON.entry('汽'), null);
  for (const word of ['还','只']) {
    assert.deepEqual(Array.from(LEXICON.entry(word).bands), ['1','3']);
    assert.equal(LEXICON.entry(word).ambiguous, true); assert.equal(LEXICON.entry(word).readings.length, 2);
    assert.equal(overLevel(word, 2)[0].hsk, null);
  }
  assert.deepEqual(Array.from(LEXICON.entry('电').mainBands), ['3']);
  assert.deepEqual(Array.from(LEXICON.entry('电').usageBands), ['5']);
  assert.deepEqual(overLevel('电', 3)[0].bands, ['3','5']);
  assert.equal(overLevel('燃油', 3)[0].hsk, null);
  assert.deepEqual(overLevel('燃油', 3)[0].bands, ['7-9']);
});

test('the browser module and service share tokens, professional boundaries and conservative grading', () => {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(ROOT + '/src/lexicon.js', 'utf8'), scope);
  const browser = scope.CDG_LEXICON.create(data);
  for (const lesson of [l4, l5]) for (const level of [0,1,2,3]) {
    const text = '我认识这个词。还只电，驱动电机有动力电池。能量回收，句子前，燃油。小龙认识王明。主语和动词。';
    const tokens = browser.inspect(text, level, { dictionary: lesson.dict, professionalWords: lesson.professionalWords });
    const expected = [...new Set(Array.from(tokens.filter(x => x.over), x => x.t))];
    assert.deepEqual(overLevel(text, level, lesson).map(x => x.w), expected);
    assert.ok(tokens.some(x => x.t === '认识' && !x.over));
    assert.ok(tokens.some(x => x.t === '驱动电机' && x.professional));
    assert.ok(tokens.some(x => x.t === '小龙')); assert.ok(tokens.some(x => x.t === '王明'));
    assert.ok(tokens.some(x => x.t === '动词' && x.professional));
    if (lesson.id === 'nev-l5') assert.ok(tokens.some(x => x.t === '能量回收' && x.professional));
  }
});

test('dictionary questions resolve the requested word instead of the copula or scaffolding', () => {
  for (const [question, word, field] of [['电是几级？','电','level'], ['前是几级？','前','level'], ['句子是几级？','句子','level'], ['只怎么读？','只','pinyin'], ['电是什么等级？','电','level']]) {
    const turn = cleanTurn({ ...base, userText: question });
    assert.deepEqual(inferLookup(turn), { kind: 'word', word, field });
    const answer = renderLookup(inferLookup(turn), turn);
    assert.equal(answer.grounding.word, word); assert.equal(answer.seal, false);
  }
  assert.equal(inferLookup(cleanTurn({ ...base, userText: '无此词是几级？' })), null);
  assert.equal(validateNpc({ intent: 'answer', lookup: { kind: 'word', word: '是', field: 'level' } }, cleanTurn({ ...base, userText: '电是几级？' })).reason, 'invalid_lookup');
  const t = cleanTurn({ ...base, userText: '只怎么读？' });
  const answer = renderLookup(inferLookup(t), t);
  assert.match(answer.zh, /zhī \/ zhǐ/); assert.equal(answer.grounding.provenance, 'third-party-dictionary');
});

test('teacher word-chain queries are not limited to level1 vocabulary', () => {
  for (const question of ['带动字还有什么词？', '带力字还有什么词？']) {
    const t = cleanTurn({ ...base, level: 0, userText: question });
    const answer = renderLookup(inferLookup(t), t);
    assert.equal(answer.grounding.kind, 'hsk-chain'); assert.ok(LEXICON.entry(answer.grounding.word).maxLevel > 1);
  }
});

test('lookup displays the official shared band; fallback respects length and vocabulary limits', () => {
  const turn = cleanTurn({ ...base, userText: '燃油是几级？' });
  const lookup = renderLookup({ kind: 'word', word: '燃油', field: 'level' }, turn);
  assert.match(lookup.en, /HSK 7-9/); assert.doesNotMatch(lookup.en, /HSK 9\./);
  for (const lesson of ['nev-l4','nev-l5']) for (const level of [0,1,2,3]) for (const role of ['wang','dragon']) {
    const t = cleanTurn({ ...base, lesson, level, role, step: 'dragon-why', userText: '为什么？' });
    const answer = fallbackTurn(t);
    assert.ok([...answer.zh.replace(/[^\p{Script=Han}]/gu, '')].length <= t.maxChars);
    assert.ok(answer.overLevel.length <= 2);
  }
});
