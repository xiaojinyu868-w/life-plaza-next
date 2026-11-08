// node test/logic.test.js
const path = require('path');
const D = require(path.join(__dirname, '../src/data.js'));
const S = require(path.join(__dirname, '../src/script.js'));
const L = require(path.join(__dirname, '../src/logic.js'));
let fail = 0, pass = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : (fail++, console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want))); };
const t = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL', name)); };

// 1) 所有台词都能被词典完整切分（不出现未知字）
const lines = [];
const walk = (o) => { if (!o) return; if (Array.isArray(o)) return o.forEach(walk); if (typeof o === 'object') { if (typeof o.zh === 'string') lines.push(o.zh); Object.values(o).forEach(walk); } };
walk(S);
for (const it of S.yeItems) lines.push(L.yeItemText(it, it.ok));
for (const it of S.neItems) lines.push(it.stem.replace('＿＿', it.ans));
for (const k of Object.keys(D.CARD)) { const c = D.CARD[k]; if (c.tb) lines.push(c.tb.ex); }
const unknown = new Set();
for (const s of lines) for (const tk of L.segment(s)) if (tk.zh && tk.tag === '?') unknown.add(tk.t + ' ← ' + s);
if (unknown.size) console.log('未收录：\n ' + [...unknown].join('\n '));
t('all lines segment fully', unknown.size === 0);

// 2) 分词
eq('seg1', L.segment('插电式混合动力汽车也是新能源汽车。').map((x) => x.t), ['插电式混合动力汽车', '也', '是', '新能源汽车', '。']);
eq('pinyin', L.pinyinOf('它有发动机'), 'tā yǒu fādòngjī');

// 3) 说一个词
t('word ok', L.heardWord('驱动电机', '驱动电机', ['发动机']).ok);
t('word pinyin', L.heardWord('qudong dianji', '驱动电机', ['发动机']).ok);
t('word pinyin tone num', L.heardWord('qu1dong4dian4ji1', '驱动电机', ['发动机']).ok);
t('word wrong', !L.heardWord('发动机', '驱动电机', ['发动机']).ok && L.heardWord('发动机', '驱动电机', ['发动机']).said === '发动机');
t('word both', L.heardWord('驱动电机还是发动机', '驱动电机', ['发动机']).both);
t('word sentence', L.heardWord('这是动力电池。', '动力电池', ['发动机']).ok);

// 4) 对 / 不是
t('confirm true', L.judgeConfirm('对。', true).ok);
t('confirm true shi', L.judgeConfirm('是的', true).ok);
t('confirm wrongNeg', L.judgeConfirm('不是', true).why === 'wrongNeg');
t('confirm false ok', L.judgeConfirm('不是，插电式混合动力汽车是新能源汽车。', false, ['是新能源汽车']).ok);
t('confirm false trap', !L.judgeConfirm('不是，插电式混合动力汽车不是新能源汽车。', false, ['是新能源汽车']).ok);
t('confirm needFix', L.judgeConfirm('不是。', false, ['有发动机']).why === 'needFix');
t('confirm fix 没有 trap', !L.judgeConfirm('不是，它没有发动机', false, ['有发动机']).ok);
t('confirm fix ok', L.judgeConfirm('不是，它有发动机', false, ['有发动机']).ok);
t('confirm wrongPos', L.judgeConfirm('对', false, ['有发动机']).why === 'wrongPos');
t('confirm warm2', L.judgeConfirm('不是，燃油车不是新能源汽车。', false, ['燃油车不是新能源汽车', '不是新能源汽车']).ok);

// 5) “也”
eq('cls ok', L.classifyYe('插电式混合动力汽车也是新能源汽车。'), 'ok');
eq('cls A', L.classifyYe('纯电动汽车是新能源汽车，也插电式混合动力汽车是新能源汽车。'), 'A');
eq('cls END', L.classifyYe('插电式混合动力汽车是新能源汽车也。'), 'END');
eq('cls ok omitted', L.classifyYe('它消耗燃油，也消耗电能。'), 'ok');
eq('cls B', L.classifyYe('我也以后更加努力。'), 'B');
const E1 = S.yeItems[0], E2 = S.yeItems[1];
eq('E1 slot2', L.judgeYeItem(E1, 2).ok, true);
eq('E1 slot1 cat', L.judgeYeItem(E1, 1).cat, 'A');
eq('E1 typed ok', L.judgeYeItem(E1, '纯电动汽车是新能源汽车，插电式混合动力汽车也是新能源汽车。').ok, true);
eq('E1 typed A', L.judgeYeItem(E1, '纯电动汽车是新能源汽车，也插电式混合动力汽车是新能源汽车').slot, 1);
eq('E2 typed END', L.judgeYeItem(E2, '插电式混合动力汽车消耗燃油，消耗电能也。').cat, 'END');
eq('E2 slot1', L.judgeYeItem(E2, 1).ok, true);
eq('item text', L.yeItemText(S.yeItems[3], 1), '要按时上班，也要按时下班。');

// 6) 教小龙
t('dragon ok', L.judgeDragonFix('不是，纯电动汽车是新能源汽车，插电式混合动力汽车也是新能源汽车。').ok);
t('dragon ok short', L.judgeDragonFix('插电式混合动力汽车也是新能源汽车').ok);
t('dragon agreed', L.judgeDragonFix('对').why === 'agreed');
t('dragon still A', L.judgeDragonFix('不是，也插电式混合动力汽车是新能源汽车').why === 'A');
t('why ok', L.judgeWhyHybrid('它有发动机，也有驱动电机。').ok);
t('why ok2', L.judgeWhyHybrid('它消耗燃油，也消耗电能').ok);
t('why no', !L.judgeWhyHybrid('因为它很好').ok);
t('dian ok', L.judgeDianWord('电机').ok && L.judgeDianWord('电话').ok);
t('dian no', !L.judgeDianWord('汽车').ok);

// 7) 学习者自问
const q1 = L.parseQuestion('纯电动汽车没有发动机，对吗？');
t('q1 truth', q1.ok && q1.truth === true);
eq('q1 answer', L.answerQuestion(q1), '对。');
const q2 = L.parseQuestion('燃油车消耗电能，对吗？');
eq('q2 answer', L.answerQuestion(q2), '不是，燃油车不消耗电能。');
const q3 = L.parseQuestion('纯电动车有发动机吗？');
eq('q3 answer', L.answerQuestion(q3), '不是，纯电动汽车没有发动机。');
eq('q shiduima', L.parseQuestion('插电式混合动力汽车是对吗？').err, 'shiduima');
eq('q ne', L.parseQuestion('燃油车呢？').err, 'ne');
eq('q yeA', L.parseQuestion('也燃油车是新能源汽车，对吗？').err, 'yeA');
eq('q noTag', L.parseQuestion('燃油车是新能源汽车。').err, 'noTag');
eq('q xhdc', L.parseQuestion('纯电动汽车消耗电池，对吗？').err, 'xhdc');
const q4 = L.parseQuestion('它也是新能源汽车，对吧', 'bev');
t('q4 also bev', q4.ok && q4.truth && q4.also);
eq('q5 ice nev', L.answerQuestion(L.parseQuestion('燃油车也是新能源汽车，对吗')), '不是，燃油车不是新能源汽车。');

// 8) 纠错
eq('fix A', L.fixYeSentence('纯电动汽车是新能源汽车，也插电式混合动力汽车是新能源汽车。'), '纯电动汽车是新能源汽车，插电式混合动力汽车也是新能源汽车。');
eq('fix END', L.fixYeSentence('插电式混合动力汽车是新能源汽车也'), '也插电式混合动力汽车是新能源汽车。'.replace('也插电式混合动力汽车', '插电式混合动力汽车也'));
t('suggest plugged has ev', L.suggest('A', {}, true)[0].ev === 'ln-ye-stat');
t('suggest unplugged no ev', L.suggest('A', {}, false)[0].ev === null);

// 9) 语料包自洽：CARD 引用的 ev 都存在；YE20 统计与 ln-ye-stat 一致
for (const [w, c] of Object.entries(D.CARD)) {
  if (!c.graph) continue;
  for (const sec of ['corpus', 'collocations', 'errors', 'confusables']) for (const it of c.graph[sec] || []) if (it.ev) t(`ev ${w}.${sec}.${it.ev}`, !!D.EV[it.ev]);
}
const cats = D.YE20.reduce((m, r) => (m[r[2]] = (m[r[2]] || 0) + 1, m), {});
eq('ye20 cats', cats, { B: 5, A: 15 });
const nat = D.YE20.reduce((m, r) => { const k = r[1].split('/')[0]; m[k] = (m[k] || 0) + 1; return m; }, {});
eq('ye20 nat', nat, { 韩国: 8, 日本: 10, 中国: 1, 新加坡: 1 });

// 教学红线：生成的干扰项池不再混入已证伪的“常见偏误”。
t('no unsupported sentence-final ye in error cards', !D.CARD['也'].graph.errors.some(e => e.ev === 'ln-ye-end'));
t('no unsupported double-question distractor in error cards', !D.CARD['对吗'].graph.errors.some(e => e.ev === 'ln-dm-0'));
t('unplugged dragon uses attested subject-order pattern, never final ye', !S.dWrongOff.zh.includes('新能源汽车也'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
