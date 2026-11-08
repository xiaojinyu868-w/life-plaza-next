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
Object.assign(G, { addEventListener: () => {}, window: G, document: doc, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, location: { search: '?debug=1' } });
G.performance = { now: () => fakeNow };
G.requestAnimationFrame = (cb) => setTimeout(() => { fakeNow += 40; cb(fakeNow); }, 2);

G.CDG_AUTOSTATE = null;
const dir = path.join(__dirname, '../src');
G.CDG_CURRENT_LESSON = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/lessons/nev-l4.json'), 'utf8'));
for (const f of ['engine.js', 'splat.js', 'data.js', 'hsk.js', 'script.js', 'logic.js', 'world.js', 'lesson.js', 'app.js']) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
setTimeout(() => {
  const { dbg, cam, W } = G.__cdg; let fail = 0;
  const ok = (name, c) => { if (!c) { fail++; console.log('FAIL', name); } else console.log('ok  ', name); };
  // 模拟已载入 Marble
  dbg.MAR.loaded = true; dbg.R.splat = {};
  dbg.applyLayout('marble');
  // 1) 18 × 11.8 的房间：全部放得下
  dbg.fitLayout({ x0: -7.9, x1: 10.4, z0: -5.6, z1: 6.2, y1: 6 });
  console.log('    FIT(18x11.8):', JSON.stringify(dbg.FIT), 'showDx', dbg.LAY.showDx.toFixed(2), 'wang', dbg.LAY.wangShow.map((x) => x.toFixed(1)).join(','));
  ok('big room fits', dbg.FIT.length === 0);
  // 2) 14 × 9 的房间：应报告放不下
  dbg.fitLayout({ x0: -5.8, x1: 8.2, z0: -4.5, z1: 4.5, y1: 5 });
  console.log('    FIT(14x9):', JSON.stringify(dbg.FIT));
  ok('small room reports', dbg.FIT.length >= 2);
  // 3) 相机限位：故意把相机拉到很远，眼睛必须回到房间里
  dbg.fitLayout({ x0: -7.9, x1: 10.4, z0: -5.6, z1: 6.2, y1: 6 });
  let inside = true;
  for (const [yaw, pitch, dist] of [[0.6, 0.3, 40], [3.0, 0.2, 25], [-1.2, 1.2, 30], [1.57, 0.05, 18]]) {
    cam.target = [1, 1, 0]; cam.yaw = yaw; cam.pitch = pitch; cam.dist = dist; dbg.clampCam();
    const cp = Math.cos(cam.pitch), e = [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)];
    const inn = e[0] >= -7.9 && e[0] <= 10.4 && e[2] >= -5.6 && e[2] <= 6.2 && e[1] <= 6;
    console.log('    eye', e.map((x) => x.toFixed(2)).join(','), 'dist', cam.dist.toFixed(2), inn ? 'inside' : 'OUTSIDE');
    inside = inside && inn;
  }
  ok('camera clamped inside', inside);
  // 4) 各站镜头在 18 米房间里也都在房间内
  for (const k of Object.keys(G.__cdg.VIEWS)) { const v = G.__cdg.VIEWS[k]; cam.target = [...v.target]; cam.yaw = v.yaw; cam.pitch = v.pitch; cam.dist = v.dist; const d0 = cam.dist; dbg.clampCam(); if (cam.dist < d0 - 1e-6) console.log('    view', k, 'shortened', d0.toFixed(2), '→', cam.dist.toFixed(2)); }
  console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0);
}, 300);
