// node test/flow.harness.js [plugged|unplugged]  —— 用假 DOM + 假 WebGL 把整节课自动跑一遍，捕获运行时错误
const fs = require('fs'), path = require('path'), vm = require('vm');
const mode = process.argv[2] || 'plugged';
const errors = [];
const origErr = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
process.on('unhandledRejection', (e) => errors.push('REJ ' + (e && e.stack || e)));

class CL { constructor(el) { this.el = el; this.s = new Set(); } add(...c) { c.forEach((x) => this.s.add(x)); } remove(...c) { c.forEach((x) => this.s.delete(x)); } toggle(c, on) { const v = on === undefined ? !this.s.has(c) : !!on; v ? this.s.add(c) : this.s.delete(c); return v; } contains(c) { return this.s.has(c); } }
class El {
  constructor(tag = 'div', id = '') { this.tagName = tag.toUpperCase(); this.id = id; this.classList = new CL(this); this.style = {}; this.dataset = {}; this.children = []; this._h = {}; this._html = ''; this.textContent = ''; this.value = ''; this.parentNode = null; this.clientWidth = 1200; this.clientHeight = 800; this.width = 0; this.height = 0; }
  set className(v) { this.classList = new CL(this); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return [...this.classList.s].join(' '); }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  append(c) { c.parentNode = this; this.children.push(c); doc._all.add(c); }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } doc._all.delete(this); }
  insertAdjacentHTML(pos, html) { this._html += html; }
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); }
  querySelector(sel) { return sel === '.answer' ? null : new El(); } querySelectorAll() { return []; }
  closest() { return null; } focus() {} setAttribute(k, v) { this['_' + k] = v; } getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; }
  setPointerCapture() {}
  getContext() { return GL; }
}
const NOOP = () => {};
const GL = new Proxy({}, { get: (t, k) => {
  if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => true;
  if (k === 'getAttribLocation') return () => 0;
  if (k === 'getUniformLocation' || k === 'createShader' || k === 'createProgram' || k === 'createBuffer') return () => ({});
  if (typeof k === 'string' && /^[A-Z_]+$/.test(k)) return 1;
  return NOOP;
} });
const ids = ['world', 'labels', 'topbar', 'steps', 'plug', 'plugTxt', 'tools', 'hud', 'gB', 'gBt', 'gF', 'gFt', 'modeTag', 'teacher', 'compare', 'board', 'cap', 'capWho', 'capLv', 'capSeal', 'capSay', 'capLine', 'capEn', 'capNext', 'inbar', 'task', 'chips', 'form', 'inp', 'mic', 'hint', 'hintline', 'msg', 'gate'];
const byId = {}; for (const i of ids) byId[i] = new El(i === 'world' ? 'canvas' : 'div', i);
const doc = {
  _all: new Set(), body: new El('body'), activeElement: null, _h: {},
  getElementById: (i) => byId[i] || [...doc._all].find((e) => e.id === i) || null,
  createElement: (t) => new El(t), addEventListener: (t, f) => { (doc._h[t] = doc._h[t] || []).push(f); }, querySelector: (s) => (s === '.modal' ? [...doc._all].find((e) => e.classList.contains('modal')) || null : null),
};
doc.body.classList = new CL(doc.body);
let fakeNow = 0;
const G = globalThis;
Object.assign(G, { addEventListener: () => {}, window: G, document: doc, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, location: { search: '' } });
G.performance = { now: () => fakeNow };
G.requestAnimationFrame = (cb) => setTimeout(() => { fakeNow += 40; cb(fakeNow); }, 2);
const answers = mode === 'plugged' ? [
  '对。',
  '✓ 我读了 · I said it', '✓ 我读了 · I said it', '✓ 我读了 · I said it', '✓ 我读了 · I said it', '🔌 插电', '✓ 我读了 · I said it',
  '驱动电机', '动力电池', '发动机', '动力电池', '驱动电机', '发动机', '插混',
  '插电式混合动力汽车也是新能源汽车。', '#slot1', '#slot2', '插电式混合动力汽车消耗燃油，消耗电能也。', '#slot1', '#slot1', '要按时上班，也要按时下班。',
  '对', '不是，也插电式混合动力汽车是新能源汽车', '不是，插电式混合动力汽车也是新能源汽车。', '它有发动机，也有驱动电机。', '一样', '电话',
  '对。', '不是，燃油车不是新能源汽车。', '不是，插电式混合动力汽车是新能源汽车。', '不是，它有发动机。', '对。', '对。',
  '是对吗', '对吗', '呢', '对吗', '呢',
  '插电式混合动力汽车是对吗？', '纯电动车消耗电池，对吗？', '纯电动汽车没有发动机，对吗？', '燃油车消耗电能，对吗？',
] : [
  '是的', '✓ 我读了 · I said it', '✓ 我读了 · I said it', '✓ 我读了 · I said it', '✓ 我读了 · I said it', '先不插（对比用）', '✓ 我读了 · I said it',
  'qudong dianji', '动力电池', '发动机', '动力电池', '驱动电机', '发动机', '新能源汽车', '插电式混合动力汽车',
  '插电式混合动力汽车也是新能源汽车。', '#slot2', '#slot1', '#slot1', '#slot1',
  '不是，插电式混合动力汽车也是新能源汽车。', '它消耗燃油，也消耗电能。', '一样', '电机',
  '对。', '不是，燃油车不是新能源汽车。', '不是', '不是，插电式混合动力汽车是新能源汽车。', '不是，它有发动机。', '对。', '对。',
  '对吗', '呢', '对吗', '呢', '也燃油车是新能源汽车，对吗？', '燃油车也是新能源汽车，对吗？', '它有动力电池吗？',
];
G.CDG_AUTOSTATE = { level: 2, station: 0, fast: true, gap: 5, answers: [...answers] };
const dir = path.join(__dirname, '../src');
G.CDG_CURRENT_LESSON = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/lessons/nev-l4.json'), 'utf8'));
for (const f of ['engine.js', 'splat.js', 'data.js', 'hsk.js', 'script.js', 'logic.js', 'world.js', 'lesson.js', 'app.js']) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
const t0 = Date.now(); const seen = [];
const timer = setInterval(() => {
  const st = G.__cdg && G.__cdg.ST;
  if (st && seen[seen.length - 1] !== st.station) seen.push(st.station);
  const modal = [...doc._all].find((e) => e.classList.contains('modal'));
  const done = modal && /出厂检验/.test(modal.innerHTML);
  if (done || errors.length || Date.now() - t0 > 100000) {
    clearInterval(timer);
    console.log(`[${mode}] stations: ${seen.join(' → ')}`);
    console.log(`[${mode}] summary shown: ${!!done}; answers left: ${G.CDG_AUTOSTATE.answers.length}; spoken=${st && st.spoken} hints=${st && st.hints} plugged=${st && st.plugged} evidence=${st && st.ev.size}`);
    if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
    if (!done) console.log('LAST task:', byId.task.innerHTML, '| msg:', byId.msg.innerHTML, '| cap:', byId.capLine.innerHTML.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, ''));
    process.exit(done && !errors.length ? 0 : 1);
  }
}, 50);
