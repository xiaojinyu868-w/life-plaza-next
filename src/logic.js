/* 插电工坊 · 判题与纠错逻辑（纯函数，可在 node 里单测） */
(function (G) {
  'use strict';
  const D = G.CDG_DATA || (typeof require !== 'undefined' ? require('./data.js') : null);
  const CJK = /[㐀-鿿]/;
  const PUNCT = /[\s，。！？、；：,.!?;:"'“”‘’…—\-（）()《》<>【】\[\]·~～＿_]/g;
  const norm = (s) => String(s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(PUNCT, '').toLowerCase();
  const TONES = { ā: 'a', á: 'a', ǎ: 'a', à: 'a', ē: 'e', é: 'e', ě: 'e', è: 'e', ī: 'i', í: 'i', ǐ: 'i', ì: 'i', ō: 'o', ó: 'o', ǒ: 'o', ò: 'o', ū: 'u', ú: 'u', ǔ: 'u', ù: 'u', ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v', ń: 'n', ň: 'n', ǹ: 'n' };
  const plainPy = (py) => String(py || '').toLowerCase().replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ]/g, (c) => TONES[c]).replace(/[^a-z]/g, '');

  // ---- 分词（词典最长匹配）----
  const WORDS = Object.keys(D.DICT).sort((a, b) => b.length - a.length);
  const MAXW = WORDS.reduce((m, w) => Math.max(m, w.length), 1);
  function segment(text) {
    const out = [], s = String(text || '');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (!CJK.test(ch)) { // 非汉字（标点、引号、字母）原样保留
        let j = i; while (j < s.length && !CJK.test(s[j])) j++;
        out.push({ t: s.slice(i, j), zh: false }); i = j; continue;
      }
      let hit = null;
      for (let L = Math.min(MAXW, s.length - i); L >= 1; L--) { const w = s.substr(i, L); if (D.DICT[w]) { hit = w; break; } }
      if (hit) { const [py, en, tag, page] = D.DICT[hit]; out.push({ t: hit, zh: true, py, en, tag, page }); i += hit.length; }
      else { out.push({ t: ch, zh: true, py: '', en: '', tag: '?' }); i += 1; }
    }
    return out;
  }
  const pinyinOf = (text) => segment(text).filter((t) => t.zh).map((t) => t.py).join(' ');

  // 出现位置前一个字不是“不 / 没”
  function hasPositive(n, frag) {
    const f = norm(frag); let i = n.indexOf(f);
    while (i >= 0) { const prev = n[i - 1]; if (prev !== '不' && prev !== '没') return true; i = n.indexOf(f, i + 1); }
    return false;
  }

  // ---- 说出一个词（认 / 辨 / 说）。支持汉字或无声调拼音 ----
  function heardWord(input, target, others = [], alts = []) {
    const n = norm(input);
    if (!n) return { ok: false, empty: true };
    if (!CJK.test(n)) {
      const p = n.replace(/[0-9]/g, '');
      for (const w of [target, ...alts]) if (D.DICT[w] && p === plainPy(D.DICT[w][0])) return { ok: true, via: 'pinyin' };
      for (const o of others) if (D.DICT[o] && p === plainPy(D.DICT[o][0])) return { ok: false, said: o };
      return { ok: false };
    }
    const hasT = [target, ...alts].some((w) => n.includes(norm(w)));
    const said = others.find((o) => n.includes(norm(o)) && !norm(target).includes(norm(o)));
    if (hasT && !said) return { ok: true };
    if (said && !hasT) return { ok: false, said };
    if (hasT && said) return { ok: false, both: true };
    return { ok: false };
  }

  // ---- 回答“……，对吗？”：对 / 不是，…… ----
  function judgeConfirm(input, truth, fixes = []) {
    const n = norm(input);
    if (!n) return { ok: false, why: 'empty' };
    const neg = n.startsWith('不是') || n.startsWith('不对') || n.startsWith('bushi') || n.startsWith('budui') || n === 'no';
    const pos = !neg && (n.startsWith('对') || n.startsWith('是') || n.startsWith('dui') || n === 'shi' || n === 'yes');
    const fixed = fixes.some((f) => hasPositive(n.replace(/^(不是|不对|bushi|budui)/, ''), f));
    if (truth) {
      if (pos) return { ok: true, recast: n.startsWith('是') ? '对。' : null };
      if (neg) return { ok: false, why: 'wrongNeg' };
      return { ok: false, why: 'unclear' };
    }
    if (pos && !fixed) return { ok: false, why: 'wrongPos' };
    if (neg) return fixed || !fixes.length ? { ok: true } : { ok: false, why: 'needFix' };
    if (fixed) return { ok: true, why: 'noBushi' };
    return { ok: false, why: 'unclear' };
  }

  // ---- “也”的位置 ----
  const SUBJ = ['插电式混合动力汽车', '纯电动汽车', '纯电动车', '燃油车', '新能源汽车', '插混', '这辆车', '这辆', '那辆', '它', '我们', '我', '你', '他', '车'];
  const VERB = ['是', '有', '消耗', '要', '不是', '没有', '可以', '会', '很', '叫', '不'];
  const ADV = ['按时', '今天', '现在', '以后', '一起', '都', '在', '从', '大部分', '同时', '当然'];
  // 返回 'ok' | 'A'(分句开头或主语前) | 'B'(主语后、状语前) | 'END'(句尾) | 'none' | 'many'
  function classifyYe(sentence) {
    const s = String(sentence || '');
    const count = (s.match(/也/g) || []).length;
    if (!count) return 'none';
    if (count > 1) return 'many';
    const clauses = s.split(/[，。；！？,.;!?]/).map((c) => c.trim()).filter(Boolean);
    const cl = clauses.find((c) => c.includes('也')) || '';
    const k = cl.indexOf('也'), before = cl.slice(0, k), after = cl.slice(k + 1);
    if (!after) return 'END';
    const startsSubj = SUBJ.some((w) => after.startsWith(w));
    const startsVerb = VERB.some((w) => after.startsWith(w));
    const startsAdv = ADV.some((w) => after.startsWith(w));
    if (!before) return startsSubj ? 'A' : startsVerb ? 'ok' : 'A';
    if (startsSubj) return 'A';
    if (startsVerb) return 'ok';
    if (startsAdv) return 'B';
    return 'other';
  }

  // 练习1：parts 中 null 为插槽。learner 可以点插槽（slot 序号），也可以直接说/打整句
  function yeItemText(item, slot) {
    let k = -1; return item.parts.map((p) => (p === null ? (++k === slot ? '也' : '') : p)).join('');
  }
  function judgeYeItem(item, input) {
    if (typeof input === 'number') {
      const cat = item.cats[input];
      return { ok: input === item.ok, slot: input, cat, sentence: yeItemText(item, input) };
    }
    const n = norm(input), base = norm(yeItemText(item, -1));
    if ((n.match(/也/g) || []).length === 1 && n.replace('也', '') === base) {
      // 找到“也”落在哪个插槽
      const at = n.indexOf('也'); let pos = 0, k = -1;
      for (const p of item.parts) {
        if (p === null) { k++; if (pos === at) return judgeYeItem(item, k); continue; }
        pos += norm(p).length;
      }
      return { ok: false, slot: -1, cat: classifyYe(input), sentence: input };
    }
    return { ok: false, slot: -1, cat: n.includes('也') ? classifyYe(input) : 'none', sentence: input, mismatch: true };
  }

  // 教小龙：把“也插电式……”纠正为“插电式混合动力汽车也是新能源汽车”
  function judgeDragonFix(input) {
    const n = norm(input);
    if (!n) return { ok: false, why: 'empty' };
    if (n === '对' || n.startsWith('对') && !n.includes('也')) return { ok: false, why: 'agreed' };
    if (n.includes('插电式混合动力汽车也是新能源汽车') && !n.includes('也插电式') && !n.endsWith('也')) return { ok: true };
    const c = classifyYe(input);
    return { ok: false, why: c === 'none' ? 'noYe' : c, cat: c };
  }
  function judgeWhyHybrid(input) {
    const n = norm(input);
    const a = (n.includes('有发动机') && (n.includes('也有驱动电机') || n.includes('也有动力电池') || n.includes('和驱动电机')))
      || (n.includes('消耗燃油') && n.includes('也消耗电能'));
    if (a) return { ok: true };
    if (n.includes('发动机') && n.includes('驱动电机')) return { ok: true, partial: true };
    return { ok: false };
  }
  const DIAN = ['电能', '电机', '电池', '驱动电机', '动力电池', '插电式', '插电', '纯电动汽车', '纯电动车', '电动', '充电', '电话', '电视', '电脑', '电影', '电子', '电梯', '电车', '电动车', '电灯', '电'];
  function judgeDianWord(input) {
    const n = norm(input);
    const w = DIAN.find((d) => d !== '电' && n.includes(d));
    return w ? { ok: true, word: w } : { ok: false };
  }

  // ---- 学习者自己用“……，对吗？”提问：解析主语 + 谓语，按事实判断 ----
  const SUBJ_TYPE = [['插电式混合动力汽车', 'phev'], ['插混', 'phev'], ['纯电动汽车', 'bev'], ['纯电动车', 'bev'], ['燃油车', 'ice']];
  const FACT = {
    phev: { nev: 1, engine: 1, motor: 1, battery: 1, fuel: 1, elec: 1 },
    bev: { nev: 1, engine: 0, motor: 1, battery: 1, fuel: 0, elec: 1 },
    ice: { nev: 0, engine: 1, motor: 0, battery: 0, fuel: 1, elec: 0 },
  };
  const NAME = { phev: '插电式混合动力汽车', bev: '纯电动汽车', ice: '燃油车' };
  const PRED = [
    ['不是新能源汽车', 'nev', 0], ['是新能源汽车', 'nev', 1],
    ['没有发动机', 'engine', 0], ['有发动机', 'engine', 1],
    ['没有驱动电机', 'motor', 0], ['有驱动电机', 'motor', 1],
    ['没有动力电池', 'battery', 0], ['有动力电池', 'battery', 1],
    ['不消耗燃油', 'fuel', 0], ['消耗燃油', 'fuel', 1],
    ['不消耗电能', 'elec', 0], ['消耗电能', 'elec', 1],
  ];
  const PHRASE = {
    nev: ['不是新能源汽车', '是新能源汽车'], engine: ['没有发动机', '有发动机'], motor: ['没有驱动电机', '有驱动电机'],
    battery: ['没有动力电池', '有动力电池'], fuel: ['不消耗燃油', '消耗燃油'], elec: ['不消耗电能', '消耗电能'],
  };
  function parseQuestion(input, focus = 'phev') {
    const n = norm(input);
    if (!n) return { err: 'empty' };
    if (/吗对吗$/.test(n)) return { err: 'maduima' };
    if (/是对吗$/.test(n)) return { err: 'shiduima', body: n.slice(0, -3) };
    let tag = null;
    for (const t of ['对吗', '对吧', '是不是', '呢', '吗']) if (n.endsWith(t)) { tag = t; break; }
    if (!tag) return { err: 'noTag', body: n };
    if (tag === '呢') return { err: 'ne', body: n.slice(0, -1) };
    let body = n.slice(0, n.length - tag.length);
    if (body.startsWith('也')) return { err: 'yeA', body };
    let type = null, sw = null;
    for (const [w, t] of SUBJ_TYPE) if (body.startsWith(w)) { type = t; sw = w; break; }
    if (!type) { const m = body.match(/^(这辆车|这辆|它|这)/); if (m) { type = focus; sw = m[0]; } }
    if (!type) return { err: 'noSubj', body };
    let rest = body.slice(sw.length);
    const also = rest.startsWith('也'); if (also) rest = rest.slice(1);
    if (rest.endsWith('也')) return { err: 'yeEnd', body };
    if (rest.includes('消耗电池')) return { err: 'xhdc', body };
    const pred = PRED.find(([p]) => rest.startsWith(p));
    if (!pred) return { err: 'noPred', body, type };
    const [p, key, pol] = pred, fact = FACT[type][key];
    return { ok: true, tag, type, subj: sw, name: NAME[type], pred: p, key, truth: !!fact === !!pol, correct: PHRASE[key][fact], also };
  }
  function answerQuestion(q) {
    if (!q.ok) return null;
    if (q.truth) return '对。';
    return `不是，${q.subj === '它' || q.subj.startsWith('这') ? '它' : q.name}${q.correct}。`;
  }

  // ---- 纠错卡：最多两条建议（与人生广场 /learn/feedback 同构：wrong / right / rightPinyin / why / sentence）----
  function suggest(kind, ctx = {}, plugged = false) {
    const out = [];
    const add = (o) => { o.rightPinyin = pinyinOf(o.right); out.push(o); };
    if (kind === 'yeA' || kind === 'A') {
      add({ wrong: ctx.wrong || '也＋主语', right: ctx.right || '主语＋也＋动词', sentence: ctx.sentence || '',
        why: 'Put 也 after the subject, right before the verb. · “也”放在主语后面、动词前面。',
        evNote: plugged ? '很多学习者也这样错：“也”被标为语序错误的 397 处里，抽查 20 处有 15 处把“也”放在分句开头或主语前。' : '', ev: plugged ? 'ln-ye-stat' : null });
    } else if (kind === 'END' || kind === 'yeEnd') {
      add({ wrong: ctx.wrong || '……也', right: ctx.right || '……也是……', sentence: ctx.sentence || '',
        why: '也 goes before the verb, not at the end. · “也”不放在句尾，放在动词前面。',
        evNote: plugged ? '语料提示：397 处“也”语序偏误里，紧挨句号的 0 处——句尾“也”不是常见错误，多半是不小心。' : '', ev: plugged ? 'ln-ye-end' : null });
    } else if (kind === 'B') {
      add({ wrong: ctx.wrong || '也＋状语', right: ctx.right || '状语＋也＋动词', sentence: ctx.sentence || '',
        why: 'Put 也 right before the verb, after words like 按时 / 今天. · “也”紧挨着动词。',
        evNote: plugged ? '语料提示：这是第二常见的错法（抽查 20 处中 5 处），如“我也以后更加努力”。' : '', ev: plugged ? 'ln-ye-3' : null });
    } else if (kind === 'shiduima') {
      add({ wrong: ctx.wrong || '是对吗', right: ctx.right || '……，对吗？', sentence: ctx.sentence || '',
        why: '对吗 comes after a complete statement. · “对吗”前面要有一句完整的话。',
        evNote: plugged ? '学习者真实偏误：“这个办法是对吗？”（中介语库，标为句式杂糅）。' : '', ev: plugged ? 'ln-dm-1' : null });
    } else if (kind === 'maduima') {
      add({ wrong: '……吗，对吗', right: '……，对吗？', sentence: ctx.sentence || '', why: 'Use only one question word. · 用了“对吗”，前面就不要“吗”。',
        evNote: plugged ? '语料提示：“对吗”在学习者作文里 25 处，逐条看过，没有一处这样叠用——比较少见。' : '', ev: plugged ? 'ln-dm-0' : null });
    } else if (kind === 'ne') {
      add({ wrong: '呢', right: '，对吗？', sentence: ctx.sentence || '', why: '呢 asks “what about …?”. To check your idea, end with ，对吗？ · 想确认自己的看法，用“对吗”。', ev: null });
    } else if (kind === 'noTag') {
      add({ wrong: ctx.wrong || '', right: '……，对吗？', sentence: ctx.sentence || '', why: 'Add ，对吗？ at the end. · 在句子后面加上“，对吗？”', ev: null });
    } else if (kind === 'xhdc') {
      add({ wrong: '消耗电池', right: ctx.right || '消耗电能', sentence: ctx.sentence || '', why: 'A car consumes 电能 (electricity), not 电池 (the battery). · 消耗的是“电能”。',
        evNote: plugged ? '语料提示：“消耗电池”教材库 0 条、新闻 1 条；“消耗电能”教材 21 条。' : '', ev: plugged ? 'ct-xh' : null });
    } else if (kind === 'noSubj' || kind === 'noPred') {
      add({ wrong: '', right: '燃油车没有驱动电机，对吗？', sentence: '燃油车没有驱动电机，对吗？', why: 'Start with a car (燃油车 / 纯电动汽车 / 插电式混合动力汽车), then 是 / 有 / 消耗 … · 先说哪辆车，再说“是 / 有 / 消耗……”。', ev: null });
    }
    return out.slice(0, 2);
  }

  // 根据学习者的错句生成“改好的整句”（用于纠错卡）
  function fixYeSentence(s) {
    const raw = String(s || '').replace(/[。！？!?]$/, '');
    const parts = raw.split(/([，,])/);
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i]; if (!c.includes('也')) continue;
      let t = c.replace('也', '');
      const subj = SUBJ.find((w) => t.startsWith(w));
      if (subj) t = subj + '也' + t.slice(subj.length);
      else { const adv = ADV.find((w) => t.startsWith(w)); t = adv ? adv + '也' + t.slice(adv.length) : '也' + t; }
      parts[i] = t;
    }
    return parts.join('') + '。';
  }

  const API = { norm, plainPy, segment, pinyinOf, heardWord, judgeConfirm, classifyYe, yeItemText, judgeYeItem, judgeDragonFix, judgeWhyHybrid, judgeDianWord, parseQuestion, answerQuestion, suggest, fixYeSentence, hasPositive, FACT, NAME };
  G.CDG_LOGIC = API;
  if (typeof module !== 'undefined') module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
