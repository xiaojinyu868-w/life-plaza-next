const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../src/pronunciation.js');
const assessment = () => ({ ok: true, mode: 'read', capability: 'L2', transcript: '驱动电机', transcriptSource: 'none', overall: 62,
  words: [{ w: '驱动电机', chars: [{ c: '驱', tone: { valid: true, ref: 1, got: 4, ok: true } }] }], seal: false });

test('reference alignment never becomes an answer; measured discrepancy makes executable drills', () => {
  const r = describe(assessment(), '驱动电机');
  assert.equal(r.canSubmit, false); assert.equal(r.transcript, ''); assert.equal(r.score, 62);
  assert.equal(r.issues.length, 1); assert.match(r.issues[0].instruction, /平着读/);
  assert.deepEqual(r.drills, ['驱', '驱动电机']);
});
test('ASR text cannot create scores or tone advice even with a malicious L1 score payload', () => {
  const r = describe({ ...assessment(), capability: 'L1', transcriptSource: 'recognition' }, '驱动电机');
  assert.equal(r.canSubmit, true); assert.equal(r.measured, false); assert.equal(r.score, null); assert.deepEqual(r.issues, []);
});
test('invalid, unknown and out-of-reference vendor tones are not used', () => {
  for (const tone of [{ valid: false, ref: 1, got: 4 }, { ref: 1, got: 4 }, { valid: true, ref: -1, got: 4 }, { valid: true, ref: 1, got: 5 }]) {
    const r = assessment(); r.words[0].chars[0].tone = tone;
    assert.equal(describe(r, '驱动电机').measured, false);
  }
  assert.equal(describe(assessment(), '发动机').measured, false);
});
test('third-tone advice defers connected pronunciation to the word, with at most two issues', () => {
  const r = assessment(); r.words = [{ w: '你好吗', chars: Array.from('你好吗', c => ({ c, tone: { valid: true, ref: 3, got: 4 } })) }];
  const view = describe(r, '你好吗'); assert.equal(view.issues.length, 2);
  assert.match(view.issues[0].instruction, /连读/); assert.doesNotMatch(view.issues[0].instruction, /扬起/);
});
test('single-character provider alignment is practiced as character, lesson word, then sentence', () => {
  const r = assessment(); r.words = [{ w: '驱', chars: [{ c: '驱', tone: { valid: true, ref: 1, got: 4 } }] }];
  assert.deepEqual(describe(r, '这是驱动电机。', ['驱动电机', '课程外的驱动力']).drills, ['驱', '驱动电机', '这是驱动电机。']);
});
