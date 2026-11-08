const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../src/lexicon.js');
// Controlled fixtures exercise the data contract, not the completeness of an imported syllabus.
const row = (word, band, readings = [], meanings = [], usageBands = []) => ({ word, records: [{ serial: 1, band, usageBands }], readings, meanings });
function data() { return { schemaVersion: 1, words: [
  row('我', '1'), row('你', '1'), row('是', '1'), row('这', '1'), row('在', '1'), row('前', '1', ['qián'], ['front']),
  row('认识', '1', ['rènshi'], ['to know']), row('认', '5'), row('识', '6'), row('句子', '2'), row('说', '1'),
  row('电', '3', ['diàn'], ['electricity'], ['5']), row('燃油', '7-9', ['rányóu'], ['fuel oil']),
  row('还', '1', ['hái', 'huán', 'hái'], ['still', 'return', 'still'], ['3']),
  row('只', '2', ['zhī', 'zhǐ'], ['classifier', 'only'], ['3']),
  row('汽车', '3'), row('车', '1'), row('动', '2'), row('力', '3'), row('电池', '5'),
  row('混合', '5'), row('混合动力', '7-9'), row('汽车站', '3'), row('站', '1'),
  row('机', '5'), row('器', '6'), row('人', '1'), row('小', '1'), row('龙', '5'), row('王', '4'),
  row('T恤', '3'), row('𠀀', '7-9'),
] }; }

test('UMD and CommonJS expose create without reading the legacy character-level table', () => {
  const window = {};
  Object.defineProperty(window, 'CDG_HSK', { get() { throw new Error('must not read legacy table'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/lexicon.js'), 'utf8'), { window });
  const lex = window.CDG_LEXICON.create(data());
  assert.equal(typeof create, 'function'); assert.equal(lex.entry('认').band, '5');
});

test('official vocabulary supports ordinary words outside the old course dictionary', () => {
  const lex = create(data()), tokens = lex.inspect('我在前，说句子。', 1);
  assert.deepEqual(tokens.map(t => t.t), ['我', '在', '前', '，', '说', '句子', '。']);
  assert.equal(tokens.find(t => t.t === '前').over, false); assert.equal(tokens.find(t => t.t === '句子').over, true);
  assert.equal(tokens.find(t => t.t === '前').tag, 'hsk');
});

test('认识 is a word; standalone 认 and 识 retain their own vocabulary levels', () => {
  const lex = create(data());
  assert.deepEqual(lex.inspect('认识，认，识', 1).filter(t => t.zh).map(t => [t.t, t.entry.maxLevel, t.over]),
    [['认识', 1, false], ['认', 5, true], ['识', 6, true]]);
  const noSingle = data(); noSingle.words = noSingle.words.filter(w => w.word !== '识');
  assert.equal(create(noSingle).inspect('识', 6)[0].entry, null);
  assert.equal(create(noSingle).inspect('识', 6)[0].over, true);
});

test('usage grades are retained; 电3(5) never passes level3 by choosing the minimum', () => {
  const lex = create(data()), e = lex.entry('电');
  assert.deepEqual(e, { band: '3', bands: ['3', '5'], mainBands: ['3'], usageBands: ['5'], ambiguous: true, maxLevel: 5,
    label: 'HSK 3 / 5级词汇（不同用法，需结合语境）', readings: ['diàn'], meanings: ['electricity'] });
  assert.equal(lex.inspect('电', 3)[0].over, true); assert.equal(lex.inspect('电', 5)[0].over, false);
});

test('7–9 remains one advanced band without invented level8/9 distinctions', () => {
  const lex = create(data()), e = lex.entry('燃油');
  assert.equal(e.band, '7-9'); assert.equal(e.maxLevel, 7); assert.equal(e.label, 'HSK 7–9级词汇');
  assert.equal(lex.inspect('燃油', 6)[0].over, true);
  for (const level of [7, 8, 9, '7-9']) assert.equal(lex.inspect('燃油', level)[0].over, false);
});

test('polyphones preserve all auxiliary readings and meanings; lesson exact match may disambiguate pronunciation', () => {
  const lex = create(data()), tokens = lex.segment('还只');
  assert.equal(tokens[0].py, 'hái / huán'); assert.equal(tokens[0].en, 'still; return');
  assert.equal(tokens[1].py, 'zhī / zhǐ'); assert.equal(tokens[0].entry.ambiguous, true);
  const local = lex.segment('还只', { dictionary: { 还: ['hái', 'still here', 'b'], 只: { py: 'zhǐ', en: 'only', tag: 'g' } } });
  assert.equal(local[0].py, 'hái'); assert.equal(local[0].en, 'still here'); assert.equal(local[1].py, 'zhǐ');
  assert.equal(local[0].entry.maxLevel, 3); assert.equal(lex.inspect('还', 1, { dictionary: { 还: ['hái', 'still', 'b'] } })[0].over, true);
});

test('multiple records and duplicate word rows merge all possible bands without overwriting', () => {
  const d = data(); d.words.push(row('还', '4', ['huán'], ['repay'], ['7-9']));
  const e = create(d).entry('还');
  assert.equal(e.band, null); assert.deepEqual(e.mainBands, ['1', '4']); assert.deepEqual(e.usageBands, ['3', '7-9']);
  assert.deepEqual(e.bands, ['1', '3', '4', '7-9']); assert.equal(e.maxLevel, 7);
  assert.deepEqual(e.readings, ['hái', 'huán']); assert.deepEqual(e.meanings, ['still', 'return', 'repay']);
});

test('unlisted course professional compounds remain whole, unknown and over-level', () => {
  const lex = create(data()), professionalWords = ['动力电池', '动力电池系统', '插电式混合动力汽车'];
  const dictionary = { 动力电池: ['dònglì diànchí', 'power battery', 'n'] };
  const tokens = lex.inspect('动力电池和动力电池系统，插电式混合动力汽车。', 6, { dictionary, professionalWords });
  const terms = tokens.filter(t => t.professional);
  assert.deepEqual(terms.map(t => t.t), professionalWords);
  assert.ok(terms.every(t => t.entry === null && t.over)); assert.equal(terms[0].py, 'dònglì diànchí');
  assert.deepEqual(lex.segment('动力电池').map(t => t.t), ['动', '力', '电池']);
});

test('course terms override overlapping ordinary words; caller supplies non-automotive terms too', () => {
  const lex = create(data());
  assert.deepEqual(lex.segment('混合动力电池', { professionalWords: ['动力电池'] }).map(t => t.t), ['混合', '动力电池']);
  const t = lex.inspect('机器人', 6, { professionalWords: ['机器人'] })[0];
  assert.equal(t.t, '机器人'); assert.equal(t.professional, true); assert.equal(t.entry, null); assert.equal(t.over, true);
});

test('names stay intact while ordinary dictionary phrases cannot hide word levels', () => {
  const lex = create(data()), dictionary = { 小龙: ['', 'Little Dragon', 'm'], 王小龙: { py: 'wáng xiǎolóng', tag: 'm' }, 我认识: ['bad shortcut', '', 'b'] };
  const tokens = lex.inspect('我认识王小龙，小龙。', 1, { dictionary });
  assert.deepEqual(tokens.map(t => t.t), ['我', '认识', '王小龙', '，', '小龙', '。']);
  assert.equal(tokens[2].tag, 'm'); assert.equal(tokens[2].professional, false); assert.equal(tokens[2].entry, null); assert.equal(tokens[2].over, true);
});

test('unknown Han, astral characters, mixed words and all text separators are preserved exactly', () => {
  const lex = create(data()), text = ' A🙂\t𠀀龘\nT恤，认识\r\n<>123！';
  const tokens = lex.inspect(text, 6);
  assert.equal(tokens.map(t => t.t).join(''), text);
  assert.equal(tokens.find(t => t.t === '𠀀').entry.band, '7-9');
  assert.equal(tokens.find(t => t.t === '龘').entry, null); assert.equal(tokens.find(t => t.t === '龘').over, true);
  assert.equal(tokens.find(t => t.t === 'T恤').entry.band, '3');
  assert.ok(tokens.filter(t => !t.zh).every(t => !t.over));
  assert.deepEqual(lex.segment(''), []);
});

test('teacher level0 retains metadata but marks no token over-level', () => {
  const tokens = create(data()).inspect('龘燃油电', 0);
  assert.ok(tokens.every(t => t.over === false)); assert.equal(tokens[0].entry, null); assert.equal(tokens[2].entry.maxLevel, 5);
});

test('input and returned object mutations cannot change the internal lexicon', () => {
  const d = data(), lex = create(d), e = lex.entry('电');
  d.words.find(w => w.word === '电').records[0].band = '1'; d.words.length = 0;
  assert.throws(() => e.bands.push('1'), TypeError); assert.throws(() => e.readings.push('fake'), TypeError);
  assert.equal(Reflect.set(e, 'maxLevel', 1), false);
  const t = lex.segment('电')[0]; t.entry = null; t.t = 'fake';
  assert.equal(lex.entry('电').maxLevel, 5); assert.equal(lex.segment('电')[0].t, '电');
});

test('prototype names are ordinary Map keys; inherited dictionary properties and getters are not trusted', () => {
  const d = data(); d.words.push(row('__proto__', '1'), row('constructor', '2'));
  const lex = create(d); assert.equal(lex.entry('__proto__').band, '1'); assert.equal(lex.entry('constructor').band, '2');
  assert.equal({}.polluted, undefined);
  const dictionary = Object.create({ 小龙: ['', '', 'm'] });
  assert.deepEqual(lex.segment('小龙', { dictionary }).map(t => t.t), ['小', '龙']);
  let read = false;
  Object.defineProperty(dictionary, '小龙', { enumerable: true, get() { read = true; return ['', '', 'm']; } });
  assert.throws(() => lex.segment('小龙', { dictionary }), { code: 'lexicon_invalid_data' }); assert.equal(read, false);
  const hostile = { schemaVersion: 1 }; Object.defineProperty(hostile, 'words', { get() { read = true; return []; } });
  assert.throws(() => create(hostile), { code: 'lexicon_invalid_data' }); assert.equal(read, false);
});

test('invalid bands, serials, shapes and oversized inputs fail with bounded fixed errors', () => {
  const invalid = [null, {}, { schemaVersion: 2, words: [] }, { schemaVersion: 1, words: {} },
    { schemaVersion: 1, words: [row('词', '8')] }, { schemaVersion: 1, words: [row('词', 3)] },
    { schemaVersion: 1, words: [row('词', '1', [], [], ['9'])] },
    { schemaVersion: 1, words: [row('词'.repeat(129), '1')] },
    { schemaVersion: 1, words: Array(20001).fill(row('词', '1')) },
    { schemaVersion: 1, words: [{ word: '词', records: [] }] },
    { schemaVersion: 1, words: [{ word: '词', records: [{ serial: 0, band: '1' }] }] }];
  for (const d of invalid) assert.throws(() => create(d), TypeError);
  const lex = create(data());
  assert.throws(() => lex.segment('车'.repeat(100001)), { code: 'lexicon_limit' });
  assert.throws(() => lex.segment(null), { code: 'lexicon_invalid_text' });
  for (const level of [-1, 10, 1.5, '1', null]) assert.throws(() => lex.inspect('车', level), { code: 'lexicon_invalid_level' });
  assert.equal(lex.entry(null), null); assert.equal(lex.entry('不存在'), null);
});

test('custom iterators and inherited array slots cannot bypass bounded validation', () => {
  const d = data(); let iterated = false;
  d.words[Symbol.iterator] = function* () { iterated = true; while (true) yield row('污染', '1'); };
  const lex = create(d); assert.equal(iterated, false); assert.equal(lex.entry('污染'), null);
  const sparse = { schemaVersion: 1, words: Array(1) };
  assert.throws(() => create(sparse), { code: 'lexicon_invalid_data' });
  const words = []; words.length = 1;
  Object.defineProperty(words, '0', { get() { throw new Error('getter must not run'); } });
  assert.throws(() => create({ schemaVersion: 1, words }), { code: 'lexicon_invalid_data' });
  const professionalWords = ['机器人'];
  professionalWords[Symbol.iterator] = function* () { throw new Error('iterator must not run'); };
  assert.equal(lex.segment('机器人', { professionalWords })[0].professional, true);
});
