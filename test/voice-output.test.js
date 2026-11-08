const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../src/voice-output.js');

function setup(overrides = {}) {
  let now = 0, next = 0, cancellations = 0;
  const timers = new Map(), scheduled = [], utterances = [], selected = { lang: 'zh-CN', localService: true };
  class Utterance { constructor(text) { this.text = text; } }
  const synthesis = { speak(u) { utterances.push(u); }, cancel() { cancellations++; } };
  const setTimer = (fn, ms) => { const timer = { fn, due: now + ms, ms, id: next++ }; timers.set(timer.id, timer); scheduled.push(timer); return timer.id; };
  const clearTimer = id => timers.delete(id);
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const due = [...timers.values()].filter(t => t.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!due) break;
      now = due.due; timers.delete(due.id); due.fn();
    }
    now = until;
  }
  const output = create({ synthesis, Utterance, voice: () => selected, enabled: () => true, setTimer, clearTimer, ...overrides });
  return { output, synthesis, utterances, timers, scheduled, advance, selected, get cancellations() { return cancellations; } };
}
const result = (started, ended, reason) => ({ started, ended, reason });

test('exports the same create factory in CommonJS and standalone browser scripts', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/voice-output.js'), 'utf8'), { window });
  assert.equal(typeof window.CDG_VOICE_OUTPUT.create, 'function');
  assert.equal(typeof create, 'function');
});

test('only actual start/end report successful playback; roles use caller-selected voice', async () => {
  for (const role of ['wang', 'dragon']) {
    const t = setup(), calls = [];
    const h = t.output.play('这是发动机。', role, { onStart: () => calls.push('start'), onEnd: r => calls.push(r) });
    const u = t.utterances[0];
    assert.equal(u.voice, t.selected); assert.equal(u.lang, 'zh-CN'); assert.equal(u.volume, 1);
    assert.equal(u.rate, role === 'dragon' ? 1 : 0.88); assert.equal(u.pitch, role === 'dragon' ? 1.5 : 0.95);
    let settled = false; h.finished.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    t.advance(1100); assert.deepEqual(calls, []);
    const start = u.onstart; start(); start(); assert.deepEqual(calls, ['start']);
    t.advance(200); u.onend();
    assert.deepEqual(await h.finished, result(true, true, 'ended'));
    assert.deepEqual(calls, ['start', result(true, true, 'ended')]); assert.equal(t.timers.size, 0);
    h.cancel(); t.output.stop(); assert.equal(t.cancellations, 0);
  }
});

test('disabled, unavailable, empty text and missing voice settle without constructing speech', async () => {
  let constructions = 0;
  class Utterance { constructor() { constructions++; } }
  for (const [overrides, text, reason] of [
    [{ enabled: () => false }, '你好', 'disabled'],
    [{ synthesis: null }, '你好', 'unavailable'],
    [{ Utterance: null }, '你好', 'unavailable'],
    [{}, ' \n ', 'empty_text'], [{}, null, 'empty_text'],
    [{ voice: () => null }, '你好', 'no_voice'],
  ]) {
    const t = setup({ Utterance, ...overrides }); let called = false;
    assert.deepEqual(await t.output.play(text, 'wang', { onStart: () => { called = true; }, onEnd: () => { called = true; } }).finished,
      result(false, false, reason));
    assert.equal(called, false); assert.equal(t.timers.size, 0); assert.equal(t.cancellations, 0);
  }
  assert.equal(constructions, 0);
});

test('missing start at 1200ms fails; late start/end and cleared timers cannot revive it', async () => {
  const t = setup(), calls = [];
  const h = t.output.play('你能说一遍吗？', 'wang', { onStart: () => calls.push('start'), onEnd: () => calls.push('end') });
  const { onstart, onend, onerror } = t.utterances[0];
  t.advance(1199); assert.equal(t.cancellations, 0); t.advance(1);
  assert.deepEqual(await h.finished, result(false, false, 'start_timeout'));
  onstart(); onend(); onerror(); t.scheduled.forEach(t => t.fn());
  assert.deepEqual(calls, []); assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 0);
});

test('playback deadline is failure after start and capped at 60 seconds', async () => {
  for (const text of ['你好', '车'.repeat(1000)]) {
    const t = setup(); let ends = 0;
    const h = t.output.play(text, 'dragon', { onEnd: () => { ends++; } });
    const { onstart, onend } = t.utterances[0]; onstart();
    const deadline = Math.min(60000, 2500 + text.length * 450);
    assert.deepEqual(t.scheduled.map(x => x.ms), [1200, deadline]);
    t.advance(deadline - 1); assert.equal(t.cancellations, 0); t.advance(1);
    assert.deepEqual(await h.finished, result(true, false, 'playback_timeout'));
    onend(); assert.equal(ends, 0); assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 0);
  }
});

test('cancel before/after start is idempotent and stop while idle does not cancel global speech', async () => {
  for (const started of [false, true]) {
    const t = setup(); t.output.stop(); assert.equal(t.cancellations, 0);
    const h = t.output.play('你好', 'wang'); const u = t.utterances[0], end = u.onend;
    if (started) u.onstart(); h.cancel(); h.cancel(); t.output.stop(); end();
    assert.deepEqual(await h.finished, result(started, false, 'cancelled'));
    assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 0);
  }
});

test('new play supersedes old; old handles, events and stale timer callbacks leave new play untouched', async () => {
  const t = setup(), oldCalls = [], newCalls = [];
  const first = t.output.play('旧句子', 'wang', { onStart: () => oldCalls.push('start'), onEnd: () => oldCalls.push('end') });
  const oldEvents = { ...t.utterances[0] }, oldTimers = t.scheduled.map(x => x.fn);
  const second = t.output.play('新句子', 'dragon', { onStart: () => newCalls.push('start'), onEnd: () => newCalls.push('end') });
  assert.deepEqual(await first.finished, result(false, false, 'superseded'));
  first.cancel(); oldEvents.onstart(); oldEvents.onend(); oldEvents.onerror(); oldTimers.forEach(fn => fn());
  assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 2); assert.deepEqual(oldCalls, []);
  t.utterances[1].onstart(); t.utterances[1].onend();
  assert.deepEqual(await second.finished, result(true, true, 'ended')); assert.deepEqual(newCalls, ['start', 'end']);
});

test('rapid switching resolves every superseded handle and leaves only latest timers', async () => {
  const t = setup(), handles = [];
  for (let i = 0; i < 100; i++) handles.push(t.output.play('连续切换', i % 2 ? 'dragon' : 'wang'));
  assert.equal(t.timers.size, 2); assert.equal(t.cancellations, 99);
  t.utterances.at(-1).onstart(); t.output.stop();
  const results = await Promise.all(handles.map(h => h.finished));
  assert.equal(results.filter(r => r.reason === 'superseded').length, 99);
  assert.deepEqual(results.at(-1), result(true, false, 'cancelled')); assert.equal(t.timers.size, 0);
});

test('engine errors and dependency exceptions settle as errors without leaking exception content', async () => {
  for (const stage of ['enabled', 'voice', 'construct', 'speak', 'event', 'cancel']) {
    const secret = new Error('sensitive provider error'); let ends = 0;
    const overrides = stage === 'enabled' ? { enabled: () => { throw secret; } }
      : stage === 'voice' ? { voice: () => { throw secret; } }
      : stage === 'construct' ? { Utterance: class { constructor() { throw secret; } } } : {};
    const t = setup(overrides);
    if (stage === 'speak') t.synthesis.speak = () => { throw secret; };
    if (stage === 'cancel') t.synthesis.cancel = () => { throw secret; };
    const h = t.output.play('你好', 'wang', { onEnd: () => { ends++; } });
    if (stage === 'event') { t.utterances[0].onstart(); t.utterances[0].onerror({ error: secret }); }
    if (stage === 'cancel') h.cancel();
    assert.deepEqual(await h.finished, result(stage === 'event', false, stage === 'cancel' ? 'cancelled' : 'error'));
    assert.equal(ends, 0); assert.equal(t.timers.size, 0);
  }
});

test('throwing callbacks cannot prevent cleanup or turn a real end into a failure', async () => {
  const t = setup(), fail = () => { throw new Error('callback'); };
  const h = t.output.play('你好', 'wang', { onStart: fail, onEnd: fail });
  t.utterances[0].onstart(); t.utterances[0].onend();
  assert.deepEqual(await h.finished, result(true, true, 'ended')); assert.equal(t.timers.size, 0);
});

test('onStart can cancel or replace current playback; old cleanup cannot cancel replacement', async () => {
  for (const replace of [false, true]) {
    const t = setup(); let second;
    const h = t.output.play('第一句', 'wang', { onStart() {
      if (replace) second = t.output.play('第二句', 'dragon'); else t.output.stop();
    } });
    const oldEnd = t.utterances[0].onend; t.utterances[0].onstart(); oldEnd();
    assert.deepEqual(await h.finished, result(true, false, replace ? 'superseded' : 'cancelled'));
    if (replace) { t.utterances[1].onstart(); t.utterances[1].onend(); assert.deepEqual(await second.finished, result(true, true, 'ended')); }
    assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 0);
  }
});

test('onEnd can start the next sentence safely, including synchronous speech engine events', async () => {
  const t = setup(); let second;
  t.synthesis.speak = u => { t.utterances.push(u); u.onstart(); u.onend(); };
  const first = t.output.play('第一句', 'wang', { onEnd() { second = t.output.play('第二句', 'dragon'); } });
  assert.deepEqual(await first.finished, result(true, true, 'ended'));
  assert.deepEqual(await second.finished, result(true, true, 'ended'));
  assert.equal(t.cancellations, 0); assert.equal(t.timers.size, 0);
});

test('end without observed start is distinguished and never fabricates a start callback', async () => {
  const t = setup(), calls = [];
  const h = t.output.play('你好', 'wang', { onStart: () => calls.push('start'), onEnd: r => calls.push(r.reason) });
  t.utterances[0].onend(); assert.deepEqual(await h.finished, result(false, true, 'end_without_start'));
  assert.deepEqual(calls, ['end_without_start']); assert.equal(t.timers.size, 0);
});

test('disabling the next play cancels the old one without constructing a new utterance', async () => {
  let enabled = true;
  const t = setup({ enabled: () => enabled }); const first = t.output.play('旧句子', 'wang');
  enabled = false; const second = t.output.play('静音', 'dragon');
  assert.deepEqual(await first.finished, result(false, false, 'superseded'));
  assert.deepEqual(await second.finished, result(false, false, 'disabled'));
  assert.equal(t.utterances.length, 1); assert.equal(t.cancellations, 1); assert.equal(t.timers.size, 0);
});
