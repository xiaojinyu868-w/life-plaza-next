const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const R = require('../src/lesson.js');
const D = require('../src/data.js');
const S = require('../src/script.js');
const H = require('../src/hsk.js');
const l4 = require('../content/lessons/nev-l4.json');
const l5 = require('../content/lessons/nev-l5.json');
const copy = x => JSON.parse(JSON.stringify(x));
async function play(lesson, opts = {}) {
  let plugged = !!opts.initialPlugged;
  const events = [], results = [], asks = [], failures = [];
  const adapter = {
    async station(id, name) { events.push(['station', id, name]); },
    async say(who, line, options) { assert.equal(typeof line.zh, 'string'); assert.ok(line.zh.length); events.push(['say', who, line, options]); },
    async action(name, args) { assert.ok(R.ACTIONS.includes(name)); events.push(['action', name, args]); if (name === 'plug') plugged = args.value; },
    async finish() { events.push(['finish']); },
    async ask(cfg) {
      assert.equal(typeof cfg.check, 'function'); asks.push(cfg.step);
      for (const text of opts.wrong?.[cfg.step] || []) { const r = cfg.check(text, false); failures.push({ step: cfg.step, text, r }); assert.equal(r.ok, false, `${cfg.step}: ${text}`); }
      const text = opts.answers?.[cfg.step] || (cfg.plugAction || cfg.step === 'l5-plug' ? opts.choosePlug ? '🔌 插电' : '先不插（对比用）' : cfg.answer || cfg.options[0]);
      const r = cfg.check(text, false); assert.equal(r.ok, true, `${cfg.step}: ${text} -> ${JSON.stringify(r)}`);
      results.push({ step: cfg.step, text, r }); return { text, r };
    }
  };
  const result = await R.run(lesson, adapter, { get plugged() { return plugged; }, level: 2, startStation: opts.startStation });
  return { events, results, asks, result, failures };
}
test('complete L4 package retains dictionary, all 40 source records, cards, HSK and six stations', () => {
  assert.deepEqual(l4.dict, D.DICT); assert.deepEqual(l4.evidence, D.EV); assert.deepEqual(l4.cards, D.CARD); assert.deepEqual(l4.hsk, H);
  assert.deepEqual(l4.stations.map(s => s.id), ['intro','a','b','d','c','end']);
  assert.equal(l4.pools.recognize.length, S.aRecog.length); assert.equal(l4.pools.discriminate.length, S.aChoose.length); assert.equal(l4.pools.nameParts.length, S.aSay.length);
  assert.equal(l4.pools.yeSockets.length, 4); assert.equal(l4.pools.confirmWarm.length, 2); assert.equal(l4.pools.confirmFacts.length, 4); assert.equal(l4.pools.questionTags.length, 4); assert.equal(l4.pools.openQuestions.length, 2);
  assert.equal(l4.assets.shelf.length, 12); assert.equal(l4.assets.shelf.filter(t => t.ev).length, 6);
  assert.deepEqual(l5.assets.shelf.map(t => t.w), l5.vocabulary); assert.ok(l5.assets.shelf.every(t => !t.ev && !t.on));
  assert.equal(R.validate(l4).steps, 39); assert.equal(R.validate(l5).steps, 16);
});
for (const lesson of [l4,l5]) for (const choosePlug of [false,true]) test(`${lesson.id} full ${choosePlug ? 'plug' : 'unplugged'} path finishes via the same adapter`, async () => {
  const run = await play(lesson, { choosePlug });
  assert.equal(run.result.finished, true); assert.equal(run.result.plugged, choosePlug);
  assert.deepEqual(run.events.filter(e => e[0] === 'station').map(e => e[1]), lesson.stations.map(s => s.id));
  assert.equal(run.events.filter(e => e[0] === 'finish').length, 1);
  assert.equal(run.events.filter(e => e[0] === 'action' && e[1] === 'departure').length, 1);
  assert.equal(run.asks.length, lesson.id === 'nev-l4' ? 35 : 16);
  if (!choosePlug || lesson.id === 'nev-l5') { assert.ok(run.results.every(x => !x.r.seal)); assert.ok(run.events.filter(e => e[0] === 'say').every(e => !e[3].seal)); }
  if (lesson.id === 'nev-l4' && choosePlug) { assert.ok(run.asks.includes('tag-on-0')); assert.ok(run.events.some(e => e[0] === 'say' && e[3].seal === 'fq-dlc-tb')); }
});
test('L4 existing plugged state skips gun prompt and retains evidence; station resume honors IDs', async () => {
  const all = await play(l4, { initialPlugged: true, answers: { 'name-vehicle': '插混' } });
  assert.equal(all.asks.length,34); assert.ok(!all.asks.includes('plug-choice'));
  assert.equal(all.results.find(x => x.step === 'name-vehicle').r.seal, 'ct-chx');
  const resumed = await play(l4, { startStation:'d' });
  assert.deepEqual(resumed.events.filter(e=>e[0]==='station').map(e=>e[1]), ['d','c','end']);
});
test('wrong attempts drive board/sparks, then correct actions; evidence and fact answers survive migration', async () => {
  const run = await play(l4, { choosePlug: true, wrong: {
    'choose-motor':['发动机'], 'say-battery':['驱动电机'], 'ye-1':['#slot1'], 'ye-2':['插电式混合动力汽车消耗燃油，消耗电能也。'],
    'dragon-fix':['对。','不是，也插电式混合动力汽车是新能源汽车。'], 'confirm-fact-0':['不是。'], 'tag-on-0':['是对吗'],
    'open-question-0':['燃油车是对吗？','纯电动汽车消耗电池，对吗？']
  }, answers: { 'dragon-word-chain':'电话','open-question-0':'纯电动汽车没有发动机，对吗？','open-question-1':'燃油车消耗电能，对吗？' } });
  assert.ok(run.events.some(e => e[0] === 'action' && e[1] === 'sparks'));
  const moves = run.events.filter(e => e[0] === 'action' && e[1] === 'animate').map(e=>e[2].part); assert.deepEqual(moves,['battery','motor','engine']);
  const ye = run.failures.find(x=>x.step==='ye-1').r; assert.equal(ye.seal,'ln-ye-stat'); assert.equal(ye.fix.sugs[0].ev,'ln-ye-stat');
  assert.equal(run.failures.find(x=>x.step==='ye-2').r.seal,'ln-ye-end');
  assert.equal(run.failures.find(x=>x.step==='confirm-fact-0').r.why,'needFix');
  assert.ok(run.events.some(e => e[0] === 'say' && e[2].zh === '不是，燃油车不消耗电能。'));
  const focus = run.events.filter(e=>e[0]==='action'&&e[1]==='focus'); assert.ok(focus.some(e=>e[2].car==='bev'&&e[2].part==='engine'));
});
test('unplugged retry gives feedback without evidence seals; a chip is not blanket word success', async () => {
  const run = await play(l4,{wrong:{'name-vehicle':['插混'],'ye-1':['#slot1'],'dragon-fix':['对。'],'tag-off-0':['是对吗']}});
  assert.ok(run.failures.every(x=>!x.r.seal && (!x.r.fix || x.r.fix.sugs.every(s=>!s.ev))));
  let checked = false;
  const adapter = { station(){},say(){},action(){},finish(){},async ask(cfg){ if (!checked) { checked=true; assert.equal(cfg.check('完全无关',true).ok,false); } const r=cfg.check(cfg.answer,false);return{text:cfg.answer,r}; }};
  await R.run(l5,adapter,{plugged:true,startStation:'a'});
});
test('L5 rejects negation/reversed conversion and never animates a forward drive as regeneration', async () => {
  const run = await play(l5, { choosePlug: true, wrong: {
    'l5-grammar-choice': ['能量回收系统把一部分电能转化成动能。'],
    'l5-grammar-say': ['能量回收系统不把一部分动能转化成电能。', '能量回收系统把一部分电能转化成动能。'],
    'l5-teach': ['不是把一部分动能转化成电能。'],
    'l5-inspect': ['电能，动能。']
  } });
  assert.equal(run.failures.length, 5);
  assert.ok(!run.events.some(e => e[0] === 'action' && e[1] === 'flow'));
  assert.ok(run.events.some(e => e[0] === 'action' && e[1] === 'focus' && e[2].part === 'battery'));
});
test('the new lesson runs as browser UMD with JSON alone, including new-word pinyin and source labels', async () => {
  const context = vm.createContext({ window:{}, console });
  for (const f of ['data.js','logic.js','lesson.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',f),'utf8'),context);
  // Parse into the UMD realm to enforce the same plain JSON semantics as a browser loader.
  context.lessonText = JSON.stringify(l5);
  vm.runInContext('lesson = JSON.parse(lessonText)', context);
  let count=0,finished=0;
  const api=context.window.CDG_LESSON;
  await api.run(context.lesson,{station(){},say(){},action(){},finish(){finished++;},async ask(cfg){count++;const text=cfg.step==='l5-repeat-2'?'nengliang huishou':cfg.answer||'先不插（对比用）';const r=cfg.check(text,false);assert.equal(r.ok,true);return{text,r};}},{plugged:false});
  assert.equal(count,16);assert.equal(finished,1);assert.equal(l5.provenance.kind,'authored-pending-review');assert.equal(l5.vocabulary.length,3);assert.equal(l5.grammar.length,1);assert.deepEqual(l5.evidence,{});assert.ok(!l5.textbook);
  const changed=copy(l5);changed.id='new-json-only';changed.title='只替换JSON';changed.stations[0].commands[2].line.zh='这是一份新的课程包。';
  assert.equal((await play(changed)).result.lesson,'new-json-only');
});
test('invalid commands, code, recursion, absent evidence and unsafe refs fail before effects', async () => {
  const mutations = [
    x=>x.stations[0].commands.unshift({op:'eval',code:'alert(1)'}),
    x=>x.stations[0].commands.unshift({op:'action',name:'fetch',args:{url:'https://example.invalid'}}),
    x=>x.stations[0].commands.unshift({op:'say',who:'wang',line:{zh:{$ref:'constructor.constructor'}}}),
    x=>delete x.evidence['ln-ye-stat'],
    x=>x.pools.recognize[0].commands.push({op:'pool',id:'recognize'}),
    x=>x.pools.recognize[0].commands.at(-1).cfg.check=()=>true,
    x=>x.pools.recognize[0].commands.at(-1).check.type='legacy',
    x=>x.stations[0].commands.unshift({op:'action',name:'wait',args:{ms:Infinity}}),
    x=>x.stations[0].id='中文站名',
    x=>x.stations[0].commands.unshift({op:'finish'}),
    x=>x.assets.shelf[0].ev='unverified-shelf',
    x=>x.assets.shelf[0].bay=4
  ];
  for(const mutate of mutations){const x=copy(l4);mutate(x);let effects=0;await assert.rejects(()=>R.run(x,{station(){effects++;},say(){effects++;},ask(){effects++;},action(){effects++;},finish(){effects++;}}));assert.equal(effects,0);}
  const forged=copy(l4);forged.cards['驱动电机'].graph.corpus[0].ev='invented';assert.throws(()=>R.validate(forged),/missing evidence/);
});
test('adapter bypass and invalid resume/level are rejected; rejected action is propagated',async()=>{
  const base={station(){},say(){},action(){},finish(){},async ask(cfg){return{text:cfg.answer,r:{ok:true}};}};
  await assert.rejects(()=>R.run(l4,base,{startStation:'missing'}),/startStation/);
  await assert.rejects(()=>R.run(l4,base,{level:99}),/level/);
  await assert.rejects(()=>R.run(l4,base),/successful checked/);
  await assert.rejects(()=>R.run(l4,{...base,action(){throw Error('renderer stopped');}}),/renderer stopped/);
});
