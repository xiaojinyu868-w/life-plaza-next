/* 插电工坊 · 3D 车间场景 */
(function (G) {
  'use strict';
  const { Node, Prim, hex, V3, tween, ease } = G.E;
  const C = {
    floor: '#e6dcc8', wall: '#f2eadb', wall2: '#e9dfcc', ink: '#2e2d33', inkBlue: '#2f4757', zhu: '#b23a2e', gold: '#b8893a',
    indigo: '#2f5d8a', stone: '#3a7d7c', steel: '#8e9297', steelD: '#5c6066', tire: '#242428', wood: '#a7794e', paper: '#fbf6ee',
    skin: '#e3bf98', cream: '#f1e2c4', glass: '#4d6577', phev: '#e7e2d6', bev: '#93b2b4', ice: '#b08a72',
  };
  const cache = {};
  const M = (k, f) => cache[k] || (cache[k] = f());
  const box = (w, h, d) => M(`b${w},${h},${d}`, () => Prim.box(w, h, d));
  const cyl = (rt, rb, h, s = 16) => M(`c${rt},${rb},${h},${s}`, () => Prim.cyl(rt, rb, h, s));
  const sph = (r, ws = 12, hs = 8) => M(`s${r},${ws},${hs}`, () => Prim.sphere(r, ws, hs));
  const part = (mesh, color, o = {}) => new Node(Object.assign({ mesh, color: hex(color) }, o));
  const grp = (o = {}) => new Node(o);

  // 让一根沿 Y 的圆柱从 a 指向 b
  function alignSeg(n, a, b) {
    const d = V3.sub(b, a), L = V3.len(d) || 1e-6, u = V3.scale(d, 1 / L);
    n.pos = V3.lerp(a, b, 0.5); n.rot = [Math.atan2(Math.hypot(u[0], u[2]), u[1]), Math.atan2(u[0], u[2]), 0]; n.scl = [1, L, 1];
  }
  const bez = (a, c, b, t) => V3.add(V3.add(V3.scale(a, (1 - t) * (1 - t)), V3.scale(c, 2 * (1 - t) * t)), V3.scale(b, t * t));

  // ------------------------------------------------------------------ 车
  function makeCar(type, colorHex) {
    const root = grp({ name: 'car-' + type }), P = { root, type, wheels: [], glass: [] };
    const body = M('carBody', () => Prim.prism([[-2.2, 0.3], [2.2, 0.3], [2.26, 0.56], [2.06, 0.84], [-2.12, 0.9], [-2.26, 0.62]], 1.76));
    const cab = M('carCab', () => Prim.prism([[-1.55, 0.86], [1.0, 0.86], [0.32, 1.42], [-1.12, 1.42]], 1.56));
    const cabG = M('carCabG', () => Prim.prism([[-1.38, 0.95], [0.84, 0.95], [0.28, 1.36], [-1.04, 1.36]], 1.585));
    P.body = root.add(part(body, colorHex));
    P.cabin = root.add(part(cab, colorHex));
    P.glass.push(root.add(part(cabG, C.glass)));
    const ws = root.add(part(box(0.025, 0.82, 1.42), C.glass, { pos: [0.67, 1.145, 0], rot: [0, 0, 0.882] })); P.glass.push(ws);
    const rw = root.add(part(box(0.025, 0.66, 1.42), C.glass, { pos: [-1.34, 1.145, 0], rot: [0, 0, -0.655] })); P.glass.push(rw);
    for (const z of [0.58, -0.58]) {
      P.glass.push(root.add(part(box(0.05, 0.1, 0.34), '#fff4d6', { pos: [2.2, 0.68, z], emis: hex('#5a4a20') })));
      root.add(part(box(0.05, 0.08, 0.36), C.zhu, { pos: [-2.24, 0.74, z], emis: hex('#3a0d08') }));
    }
    // 轮子（外层定朝向，内层绕轴转）
    for (const x of [1.4, -1.4]) for (const z of [0.8, -0.8]) {
      const w = root.add(grp({ pos: [x, 0.34, z], rot: [Math.PI / 2, 0, 0] }));
      const spin = w.add(grp());
      spin.add(part(cyl(0.34, 0.34, 0.24, 18), C.tire));
      spin.add(part(cyl(0.2, 0.2, 0.25, 10), '#c9c4ba'));
      for (let k = 0; k < 5; k++) spin.add(part(box(0.05, 0.26, 0.3), C.steelD, { rot: [0, (k / 5) * Math.PI * 2, 0] }));
      P.wheels.push(spin);
    }
    for (const x of [1.4, -1.4]) root.add(part(cyl(0.035, 0.035, 1.5, 8), C.steel, { pos: [x, 0.34, 0], rot: [Math.PI / 2, 0, 0] }));
    // 内部部件
    if (type !== 'bev') {
      const e = root.add(grp({ pos: [1.5, 0.64, -0.3], pick: 'engine' }));
      e.add(part(box(0.7, 0.44, 0.6), '#3b3a42'));
      e.add(part(box(0.58, 0.1, 0.42), C.gold, { pos: [0, 0.27, 0] }));
      for (let k = 0; k < 3; k++) e.add(part(cyl(0.045, 0.045, 0.16, 8), C.steel, { pos: [-0.18 + k * 0.18, 0.36, 0] }));
      P.engine = e;
      const t = root.add(grp({ pos: [-1.5, 0.45, 0], pick: 'tank' }));
      t.add(part(box(0.5, 0.26, 0.86), C.gold)); P.tank = t;
    }
    if (type !== 'ice') {
      const m = root.add(grp({ pos: type === 'bev' ? [1.45, 0.5, 0] : [1.47, 0.5, 0.42], pick: 'motor' }));
      m.add(part(cyl(0.21, 0.21, 0.46, 16), C.indigo, { rot: [Math.PI / 2, 0, 0] }));
      m.add(part(cyl(0.13, 0.13, 0.5, 10), C.steel, { rot: [Math.PI / 2, 0, 0] }));
      for (let k = 0; k < 4; k++) m.add(part(box(0.46, 0.03, 0.03), '#dfe6ea', { pos: [0, 0, 0], rot: [0, 0, k * Math.PI / 4] }));
      P.motor = m; P.motorSpin = m.children[2];
      const b = root.add(grp({ pos: [-0.1, 0.4, 0], pick: 'battery' }));
      b.add(part(box(2.0, 0.13, 1.36), C.stone));
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) b.add(part(box(0.44, 0.04, 0.6), '#5fa6a2', { pos: [-0.72 + i * 0.48, 0.085, -0.32 + j * 0.64] }));
      P.battery = b;
      const pt = root.add(grp({ pos: [-1.78, 0.74, 0.885], pick: 'port' }));
      pt.add(part(box(0.22, 0.17, 0.04), C.ink)); P.portGlow = pt.add(part(cyl(0.05, 0.05, 0.05, 10), '#6f8f9a', { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.02] }));
      P.port = pt;
    }
    // 能量流路线（车身局部坐标）
    P.paths = {};
    if (type !== 'bev') P.paths.fuel = [[-1.5, 0.5, 0], [-0.4, 0.52, -0.3], [1.2, 0.56, -0.3], [1.5, 0.64, -0.3], [1.4, 0.36, -0.55]];
    if (type !== 'ice') {
      P.paths.elec = [[-0.1, 0.42, 0.3], [0.8, 0.46, 0.42], [1.47, 0.5, 0.42], [1.4, 0.36, 0.62]];
      P.paths.charge = [[-1.78, 0.74, 0.9], [-1.5, 0.55, 0.6], [-0.8, 0.44, 0.3]];
    }
    P.flows = {};
    return P;
  }
  function setXray(P, on) {
    for (const n of [P.body, P.cabin]) { n.alpha = on ? 0.13 : 1; n.rim = on ? 0.85 : 0; }
    for (const g of P.glass) { g.alpha = on ? 0.08 : 1; g.rim = on ? 0.3 : 0; }
  }

  // 能量流：一串小球沿折线移动
  class Flow {
    constructor(parent, pts, color, n = 12) {
      this.pts = pts; this.t = 0; this.on = false; this.speed = 0.35; this.dots = [];
      const segs = []; let L = 0;
      for (let i = 0; i < pts.length - 1; i++) { const l = V3.len(V3.sub(pts[i + 1], pts[i])); segs.push(l); L += l; }
      this.segs = segs; this.L = L;
      for (let i = 0; i < n; i++) this.dots.push(parent.add(part(sph(0.045, 8, 6), color, { emis: V3.scale(hex(color), 0.9), visible: false })));
    }
    at(u) {
      let d = u * this.L;
      for (let i = 0; i < this.segs.length; i++) { if (d <= this.segs[i]) return V3.lerp(this.pts[i], this.pts[i + 1], d / this.segs[i]); d -= this.segs[i]; }
      return this.pts[this.pts.length - 1];
    }
    update(dt) {
      this.t = (this.t + dt * this.speed) % 1;
      this.dots.forEach((n, i) => { n.visible = this.on; if (this.on) n.pos = this.at((i / this.dots.length + this.t) % 1); });
    }
  }

  // 火花
  class Sparks {
    constructor(root) { this.root = root; this.ps = []; for (let i = 0; i < 22; i++) this.ps.push({ n: root.add(part(box(0.05, 0.05, 0.05), '#ffd27a', { emis: hex('#ff9a3a'), visible: false, alpha: 1 })), v: [0, 0, 0], life: 0 }); }
    burst(p) { for (const s of this.ps) { s.n.pos = [...p]; s.v = [(Math.random() - 0.5) * 3, Math.random() * 2.6 + 0.6, (Math.random() - 0.5) * 3]; s.life = 0.55 + Math.random() * 0.3; s.n.visible = true; } }
    update(dt) {
      for (const s of this.ps) {
        if (s.life <= 0) { s.n.visible = false; continue; }
        s.life -= dt; s.v[1] -= 6 * dt; s.n.pos = V3.add(s.n.pos, V3.scale(s.v, dt)); s.n.alpha = Math.max(0, Math.min(1, s.life * 2)); s.n.rim = 0.001;
      }
    }
  }

  // ------------------------------------------------------------------ 人物
  function makePerson() {
    const r = grp({ name: 'wangming' });
    for (const z of [0.1, -0.1]) r.add(part(cyl(0.075, 0.065, 0.82, 10), '#2b2e35', { pos: [0, 0.41, z] }));
    for (const z of [0.1, -0.1]) r.add(part(box(0.24, 0.08, 0.12), '#1f1f22', { pos: [0.05, 0.04, z] }));
    r.add(part(cyl(0.2, 0.17, 0.62, 12), C.inkBlue, { pos: [0, 1.12, 0], scl: [1, 1, 0.72] }));
    r.add(part(box(0.02, 0.5, 0.06), C.gold, { pos: [0.15, 1.12, 0.08] }));
    r.add(part(box(0.02, 0.5, 0.06), C.gold, { pos: [0.15, 1.12, -0.08] }));
    r.add(part(cyl(0.06, 0.07, 0.08, 10), C.skin, { pos: [0, 1.46, 0] }));
    const head = r.add(grp({ pos: [0, 1.62, 0] }));
    head.add(part(sph(0.15, 14, 10), C.skin));
    head.add(part(cyl(0.155, 0.16, 0.1, 14), C.zhu, { pos: [0, 0.1, 0] }));
    head.add(part(box(0.14, 0.02, 0.22), C.zhu, { pos: [0.13, 0.06, 0] }));
    for (const z of [0.055, -0.055]) head.add(part(sph(0.018, 6, 4), '#1c1c1c', { pos: [0.135, 0.01, z] }));
    const arm = (z) => { const p = r.add(grp({ pos: [0, 1.36, z] })); p.add(part(cyl(0.055, 0.05, 0.58, 8), C.inkBlue, { pos: [0, -0.29, 0] })); p.add(part(sph(0.055, 8, 6), C.skin, { pos: [0, -0.6, 0] })); return p; };
    const armR = arm(0.26), armL = arm(-0.26);
    return { root: r, head, armR, armL };
  }
  function makeDragon() {
    const r = grp({ name: 'xiaolong' });
    const body = r.add(grp({ pos: [0, 0, 0] }));
    body.add(part(sph(0.3, 14, 10), C.zhu, { pos: [0, 0.52, 0], scl: [1, 1.05, 0.9] }));
    body.add(part(sph(0.22, 12, 8), C.cream, { pos: [0.13, 0.5, 0], scl: [0.6, 1, 0.85] }));
    for (const z of [0.13, -0.13]) { body.add(part(cyl(0.07, 0.08, 0.24, 8), C.zhu, { pos: [0.02, 0.14, z] })); body.add(part(box(0.16, 0.06, 0.12), C.cream, { pos: [0.06, 0.03, z] })); }
    for (const z of [0.27, -0.27]) body.add(part(cyl(0.045, 0.04, 0.22, 8), C.zhu, { pos: [0.08, 0.6, z], rot: [z > 0 ? 0.9 : -0.9, 0, -0.5] }));
    for (const z of [0.2, -0.2]) body.add(part(box(0.24, 0.02, 0.16), C.gold, { pos: [-0.2, 0.74, z], rot: [z > 0 ? -0.5 : 0.5, 0, 0.4] }));
    for (let k = 0; k < 3; k++) body.add(part(cyl(0, 0.05, 0.12, 6), C.gold, { pos: [-0.2 - k * 0.06, 0.82 - k * 0.15, 0], rot: [0, 0, 0.6 + k * 0.2] }));
    const tail = body.add(grp({ pos: [-0.26, 0.36, 0] }));
    [[0, 0, 0.13], [-0.16, 0.03, 0.1], [-0.3, 0.1, 0.075], [-0.41, 0.2, 0.05]].forEach(([x, y, s]) => tail.add(part(sph(s, 8, 6), C.zhu, { pos: [x, y, 0] })));
    tail.add(part(cyl(0, 0.06, 0.12, 6), C.gold, { pos: [-0.47, 0.29, 0], rot: [0, 0, 0.7] }));
    const head = body.add(grp({ pos: [0.06, 1.0, 0] }));
    head.add(part(sph(0.25, 14, 10), C.zhu));
    head.add(part(box(0.2, 0.14, 0.22), C.cream, { pos: [0.22, -0.06, 0] }));
    for (const z of [0.05, -0.05]) head.add(part(sph(0.016, 6, 4), '#3a1a14', { pos: [0.325, -0.02, z] }));
    for (const z of [0.1, -0.1]) { head.add(part(sph(0.065, 10, 8), '#ffffff', { pos: [0.17, 0.07, z] })); head.add(part(sph(0.036, 8, 6), '#161616', { pos: [0.225, 0.08, z] })); }
    for (const z of [0.11, -0.11]) head.add(part(cyl(0, 0.05, 0.2, 6), C.gold, { pos: [-0.06, 0.25, z], rot: [z > 0 ? 0.3 : -0.3, 0, -0.35] }));
    return { root: r, body, head, tail };
  }

  // ------------------------------------------------------------------ 语料库充电枪
  function makeCharger(root, at) {
    const post = root.add(grp({ pos: at, name: 'charger', pick: 'charger' }));
    post.add(part(box(0.62, 0.08, 0.62), C.ink, { pos: [0, 0.04, 0] }));
    post.add(part(box(0.4, 1.56, 0.32), '#3a3940', { pos: [0, 0.86, 0] }));
    post.add(part(box(0.32, 0.9, 0.02), C.paper, { pos: [0, 0.95, 0.17] }));
    post.add(part(box(0.48, 0.08, 0.4), C.zhu, { pos: [0, 1.68, 0] }));
    const plaque = post.add(part(box(0.26, 0.26, 0.03), C.zhu, { pos: [0, 1.28, 0.185] }));
    const holster = [at[0] + 0.27, at[1] + 1.02, at[2] + 0.02];
    post.add(part(box(0.08, 0.2, 0.14), C.ink, { pos: [0.24, 1.0, 0] }));
    const gun = root.add(grp({ pos: [...holster], pick: 'charger' }));
    gun.add(part(box(0.09, 0.22, 0.1), C.ink, { pos: [0, -0.05, 0] }));
    gun.add(part(cyl(0.04, 0.05, 0.16, 10), C.indigo, { pos: [0, 0.1, 0] }));
    const cable = []; for (let i = 0; i < 16; i++) cable.push(root.add(part(cyl(0.022, 0.022, 1, 6), '#1d1d21')));
    const base = [at[0] + 0.18, at[1] + 0.36, at[2] + 0.1];
    const S = { post, plaque, gun, cable, holster, base, plugged: false };
    S.updateCable = () => {
      const a = S.base, b = V3.add(gun.pos, [0, -0.16, 0]), mid = V3.add(V3.lerp(a, b, 0.5), [0, -0.55, 0]);
      let prev = a; for (let i = 0; i < cable.length; i++) { const p = bez(a, mid, b, (i + 1) / cable.length); alignSeg(cable[i], prev, p); prev = p; }
    };
    S.updateCable();
    S.moveTo = (p) => {
      const d = V3.sub(p, post.pos); post.pos = [...p];
      S.holster = V3.add(S.holster, d); S.base[0] += d[0]; S.base[1] += d[1]; S.base[2] += d[2];
      if (!S.plugged) gun.pos = [...S.holster]; S.updateCable();
    };
    return S;
  }

  // ------------------------------------------------------------------ 车间
  function buildWorld() {
    const root = grp({ name: 'world' });
    const W = { root, C, labels: [] };
    const shell = root.add(grp({ name: 'shell' })); W.shell = shell;
    const floor = shell.add(part(M('floor', () => Prim.plane(48, 30)), C.floor, { pos: [4, 0, 0], grid: 1.0 }));
    W.floor = floor;
    // 举升机工位地标线（赭金）
    const line = (x, z, w, d) => shell.add(part(box(w, 0.012, d), C.gold, { pos: [x, 0.006, z] }));
    line(0, 1.9, 6.4, 0.07); line(0, -1.9, 6.4, 0.07); line(3.2, 0, 0.07, 3.8); line(-3.2, 0, 0.07, 3.8);
    // 墙
    shell.add(part(box(48, 7, 0.3), C.wall, { pos: [4, 3.5, -9.15] }));
    shell.add(part(box(0.3, 7, 30), C.wall2, { pos: [-20.15, 3.5, 0] }));
    shell.add(part(box(0.3, 7, 11), C.wall2, { pos: [28.15, 3.5, -9.5] }));
    shell.add(part(box(0.3, 7, 11), C.wall2, { pos: [28.15, 3.5, 9.5] }));
    shell.add(part(box(0.3, 2.2, 8), C.wall2, { pos: [28.15, 5.9, 0] }));
    shell.add(part(box(0.1, 4.8, 8), '#fff6e2', { pos: [28.4, 2.4, 0], emis: hex('#6b6150') }));
    shell.add(part(box(48, 0.5, 0.32), C.ink, { pos: [4, 0.25, -8.98] }));
    // 高窗（暖光）
    W.windows = [];
    for (let i = 0; i < 6; i++) W.windows.push(shell.add(part(box(3.2, 1.2, 0.05), '#fff3d8', { pos: [-14 + i * 6.4, 5.2, -8.98], emis: hex('#5d5545') })));
    // 顶灯
    W.lamps = [];
    for (let i = 0; i < 5; i++) for (const z of [-3.5, 3.5]) W.lamps.push(shell.add(part(box(3.0, 0.08, 0.3), '#fff9ec', { pos: [-8 + i * 6.5, 6.6, z], emis: hex('#5a5240') })));
    // 工具墙
    shell.add(part(box(5.6, 2.2, 0.06), '#d8ccb3', { pos: [-4.5, 2.1, -8.96] }));
    for (let i = 0; i < 7; i++) shell.add(part(box(0.08, 0.5 + (i % 3) * 0.15, 0.06), C.ink, { pos: [-6.8 + i * 0.75, 2.3, -8.9] }));
    for (let i = 0; i < 5; i++) shell.add(part(cyl(0.12, 0.12, 0.05, 12), C.zhu, { pos: [-6.4 + i * 1.0, 1.55, -8.9], rot: [Math.PI / 2, 0, 0] }));
    // 工作台
    shell.add(part(box(3.0, 0.08, 1.0), C.wood, { pos: [-11, 0.92, -7.6] }));
    for (const x of [-12.3, -9.7]) for (const z of [-7.2, -8.0]) shell.add(part(box(0.08, 0.9, 0.08), C.ink, { pos: [x, 0.45, z] }));
    shell.add(part(box(0.6, 0.35, 0.4), C.zhu, { pos: [-11.6, 1.13, -7.6] }));
    // 轮胎堆
    for (let i = 0; i < 4; i++) shell.add(part(cyl(0.4, 0.4, 0.26, 16), C.tire, { pos: [-13.5, 0.13 + i * 0.27, 3.8] }));
    // 举升机
    for (const z of [1.42, -1.42]) {
      root.add(part(box(0.6, 0.05, 0.6), C.steelD, { pos: [0, 0.025, z] }));
      root.add(part(box(0.28, 3.1, 0.28), C.zhu, { pos: [0, 1.55, z] }));
      root.add(part(box(0.36, 0.1, 0.36), C.ink, { pos: [0, 3.1, z] }));
    }
    W.liftY = 0.85;
    W.arms = [];
    for (const z of [1.42, -1.42]) for (const sx of [1, -1]) W.arms.push(root.add(part(box(1.3, 0.07, 0.12), C.steelD, { pos: [sx * 0.62, W.liftY + 0.27, z * 0.78], rot: [0, sx * (z > 0 ? 0.35 : -0.35), 0] })));
    // 举升机上的插混车
    W.car = makeCar('phev', C.phev);
    W.car.root.pos = [0, W.liftY, 0];
    root.add(W.car.root);
    // 能量流
    const mkFlows = (P) => {
      if (P.paths.fuel) P.flows.fuel = new Flow(P.root, P.paths.fuel, C.gold, 12);
      if (P.paths.elec) P.flows.elec = new Flow(P.root, P.paths.elec, '#4f86c6', 12);
      if (P.paths.charge) P.flows.charge = new Flow(P.root, P.paths.charge, '#4f86c6', 8);
    };
    mkFlows(W.car);
    // 三车展台
    const showDeco = [part(box(5.2, 0.12, 9.6), '#e0d3bb', { pos: [11, 0.06, 0] }), part(box(5.3, 0.04, 9.7), C.ink, { pos: [11, 0.02, 0] })];
    W.show = {
      ice: makeCar('ice', C.ice), bev: makeCar('bev', C.bev), phev: makeCar('phev', C.phev),
    };
    W.show.ice.root.pos = [11, 0.12, -3.1]; W.show.bev.root.pos = [11, 0.12, 0]; W.show.phev.root.pos = [11, 0.12, 3.1];
    const showArea = root.add(grp({ name: 'showArea' })); W.showArea = showArea;
    for (const k of ['ice', 'bev', 'phev']) { showArea.add(W.show[k].root); mkFlows(W.show[k]); }
    // 质检台（朱砂框）
    const pad = (x, z, w, d) => W.showArea.add(part(box(w, 0.02, d), C.zhu, { pos: [x, 0.13, z] }));
    for (const d of showDeco) W.showArea.add(d);
    pad(11, 4.2, 5.0, 0.06); pad(11, 2.0, 5.0, 0.06); pad(13.5, 3.1, 0.06, 2.2); pad(8.5, 3.1, 0.06, 2.2);
    // 搭配货架（左后）
    W.shelf = { root: root.add(grp({ pos: [-8.6, 0, -6.6] })), bays: [], tags: [] };
    const sh = W.shelf.root;
    for (let i = 0; i <= 3; i++) sh.add(part(box(0.08, 2.5, 0.6), C.wood, { pos: [-2.4 + i * 1.6, 1.25, 0] }));
    for (const y of [0.55, 1.25, 1.95]) sh.add(part(box(4.9, 0.05, 0.62), C.wood, { pos: [0, y, 0] }));
    W.shelf.bays = [{ name: '汽车', x: -1.6 }, { name: '电机', x: 0 }, { name: '电池', x: 1.6 }];
    // 人物
    W.wang = makePerson(); W.wang.root.pos = [3.7, 0, 0.5]; root.add(W.wang.root);
    W.dragon = makeDragon(); W.dragon.root.pos = [-6, 0, 3.4]; W.dragon.root.visible = false; root.add(W.dragon.root);
    // 语料库充电枪
    W.charger = makeCharger(root, [-3.4, 0, 2.4]);
    W.sparks = new Sparks(root);
    W.allFlows = () => [W.car, W.show.ice, W.show.bev, W.show.phev].flatMap((P) => Object.values(P.flows));
    return W;
  }

  // 朝向：本地 +x 朝向目标
  function face(node, target) { const d = V3.sub(target, node.pos); node.rot[1] = Math.atan2(-d[2], d[0]); }

  G.CDG_WORLD = { buildWorld, setXray, face, alignSeg, bez, C };
})(window);
