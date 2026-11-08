/* 插电工坊 · 微型 WebGL 引擎（无外部依赖，离线可用）
 * 低多边形平面着色、场景树、透明排序、射线拾取、轨道相机、补间动画、3D→屏幕投影。 */
(function (G) {
  'use strict';
  const V3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };

  const M4 = {
    ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    persp(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), m = new Float32Array(16);
      m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf; return m;
    },
    lookAt(eye, c, up) {
      const z = V3.norm(V3.sub(eye, c)), x = V3.norm(V3.cross(up, z)), y = V3.cross(z, x), m = new Float32Array(16);
      m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
      m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
      m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
      m[12] = -V3.dot(x, eye); m[13] = -V3.dot(y, eye); m[14] = -V3.dot(z, eye); m[15] = 1;
      return m;
    },
    // T * Ry * Rx * Rz * S
    trs(p, r, s) {
      const cx = Math.cos(r[0]), sx = Math.sin(r[0]), cy = Math.cos(r[1]), sy = Math.sin(r[1]), cz = Math.cos(r[2]), sz = Math.sin(r[2]);
      const r00 = cy * cz + sy * sx * sz, r01 = -cy * sz + sy * sx * cz, r02 = sy * cx;
      const r10 = cx * sz, r11 = cx * cz, r12 = -sx;
      const r20 = -sy * cz + cy * sx * sz, r21 = sy * sz + cy * sx * cz, r22 = cy * cx;
      const m = new Float32Array(16);
      m[0] = r00 * s[0]; m[1] = r10 * s[0]; m[2] = r20 * s[0];
      m[4] = r01 * s[1]; m[5] = r11 * s[1]; m[6] = r21 * s[1];
      m[8] = r02 * s[2]; m[9] = r12 * s[2]; m[10] = r22 * s[2];
      m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
      return m;
    },
    invert(a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      const o = new Float32Array(16);
      if (!det) return o;
      det = 1 / det;
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return o;
    },
    point(m, p) {
      const x = p[0], y = p[1], z = p[2], w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
    },
    dir(m, d) { return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]]; },
    normal(a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[4], a11 = a[5], a12 = a[6], a20 = a[8], a21 = a[9], a22 = a[10];
      const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
      let det = a00 * b01 + a01 * b11 + a02 * b21;
      const o = new Float32Array(9);
      if (!det) { o[0] = o[4] = o[8] = 1; return o; }
      det = 1 / det;
      o[0] = b01 * det; o[3] = (-a22 * a01 + a02 * a21) * det; o[6] = (a12 * a01 - a02 * a11) * det;
      o[1] = b11 * det; o[4] = (a22 * a00 - a02 * a20) * det; o[7] = (-a12 * a00 + a02 * a10) * det;
      o[2] = b21 * det; o[5] = (-a21 * a00 + a01 * a20) * det; o[8] = (a11 * a00 - a01 * a10) * det;
      return o;
    },
  };

  // ---------- 几何体（非索引，平面法线） ----------
  function Geo() { this.p = []; this.n = []; }
  Geo.prototype.tri = function (a, b, c) {
    const n = V3.norm(V3.cross(V3.sub(b, a), V3.sub(c, a)));
    this.p.push(...a, ...b, ...c); this.n.push(...n, ...n, ...n);
  };
  Geo.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };
  Geo.prototype.done = function () {
    const p = new Float32Array(this.p), n = new Float32Array(this.n);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    return { p, n, count: p.length / 3, min, max, buf: null };
  };

  const Prim = {
    box(w, h, d) {
      const g = new Geo(), x = w / 2, y = h / 2, z = d / 2;
      const P = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
      const F = [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [7, 6, 2, 3], [0, 1, 5, 4]];
      for (const f of F) g.quad(P[f[0]], P[f[1]], P[f[2]], P[f[3]]);
      return g.done();
    },
    // 沿 Y 轴的圆柱/圆台，中心在原点
    cyl(rt, rb, h, seg = 16, caps = true) {
      const g = new Geo(), y = h / 2;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const b0 = [c0 * rb, -y, s0 * rb], b1 = [c1 * rb, -y, s1 * rb], t0 = [c0 * rt, y, s0 * rt], t1 = [c1 * rt, y, s1 * rt];
        if (rt > 0) g.quad(b0, t0, t1, b1); else g.tri(b0, t0, b1);
        if (caps) {
          if (rt > 0) g.tri([0, y, 0], t1, t0);
          if (rb > 0) g.tri([0, -y, 0], b0, b1);
        }
      }
      return g.done();
    },
    sphere(r, ws = 12, hs = 8) {
      const g = new Geo(), pt = (i, j) => {
        const th = (j / hs) * Math.PI, ph = (i / ws) * Math.PI * 2;
        return [r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)];
      };
      for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        if (j === 0) g.tri(a, c, d); else if (j === hs - 1) g.tri(a, b, c); else g.quad(a, b, c, d);
      }
      return g.done();
    },
    // 凸多边形（xy 平面）沿 z 挤出，厚度 d
    prism(pts, d) {
      const g = new Geo(), z = d / 2, n = pts.length;
      const F = pts.map((q) => [q[0], q[1], z]), B = pts.map((q) => [q[0], q[1], -z]);
      for (let i = 1; i < n - 1; i++) { g.tri(F[0], F[i], F[i + 1]); g.tri(B[0], B[i + 1], B[i]); }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; g.quad(B[i], B[j], F[j], F[i]); }
      return g.done();
    },
    plane(w, d) {
      const g = new Geo(), x = w / 2, z = d / 2;
      g.quad([-x, 0, z], [x, 0, z], [x, 0, -z], [-x, 0, -z]);
      return g.done();
    },
  };

  // ---------- 场景节点 ----------
  let NID = 0;
  class Node {
    constructor(o = {}) {
      this.id = ++NID; this.pos = [0, 0, 0]; this.rot = [0, 0, 0]; this.scl = [1, 1, 1];
      this.children = []; this.parent = null; this.mesh = null; this.color = [1, 1, 1]; this.emis = [0, 0, 0];
      this.alpha = 1; this.visible = true; this.pick = null; this.grid = 0; this.rim = 0; this.world = M4.ident(); this.name = '';
      Object.assign(this, o);
    }
    add(c) { if (c.parent) c.parent.remove(c); c.parent = this; this.children.push(c); return c; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
    worldPos(local = [0, 0, 0]) { return M4.point(this.world, local); }
    traverse(f) { f(this); for (const c of this.children) c.traverse(f); }
  }

  const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

  // ---------- 渲染器 ----------
  const VS = `attribute vec3 aP;attribute vec3 aN;uniform mat4 uM;uniform mat4 uVP;uniform mat3 uNM;varying vec3 vN;varying vec3 vW;
void main(){vec4 w=uM*vec4(aP,1.0);vW=w.xyz;vN=uNM*aN;gl_Position=uVP*w;}`;
  const FS = `precision mediump float;varying vec3 vN;varying vec3 vW;
uniform vec3 uColor;uniform vec3 uEmis;uniform vec3 uLight;uniform vec3 uSky;uniform vec3 uGround;uniform vec3 uFog;uniform vec3 uCam;
uniform float uAlpha;uniform float uFogN;uniform float uFogF;uniform float uGrid;uniform float uRim;uniform float uBright;
void main(){vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;
float df=max(dot(n,uLight),0.0);float hm=0.5+0.5*n.y;vec3 amb=mix(uGround,uSky,hm);
vec3 col=uColor*(amb*0.6+df*0.46)*uBright;
if(uGrid>0.0){vec2 f=abs(fract(vW.xz/uGrid)-0.5);float l=smoothstep(0.462,0.5,max(f.x,f.y));col=mix(col,col*0.82,l);}
vec3 V=normalize(uCam-vW);float rm=pow(1.0-abs(dot(n,V)),2.2);col+=uRim*rm*vec3(0.30,0.52,0.62);
col+=uEmis;float d=length(uCam-vW);col=mix(col,uFog,smoothstep(uFogN,uFogF,d));
float a=uAlpha+uRim*rm*0.35;gl_FragColor=vec4(col,clamp(a,0.0,1.0));}`;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const opts = { antialias: true, alpha: false, preserveDrawingBuffer: true };
      const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      this.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      this.splat = null;
      if (!gl) throw new Error('WebGL 不可用');
      this.gl = gl;
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      this.pr = pr; gl.useProgram(pr);
      this.a = { p: gl.getAttribLocation(pr, 'aP'), n: gl.getAttribLocation(pr, 'aN') };
      this.u = {};
      for (const k of ['uM', 'uVP', 'uNM', 'uColor', 'uEmis', 'uLight', 'uSky', 'uGround', 'uFog', 'uCam', 'uAlpha', 'uFogN', 'uFogF', 'uGrid', 'uRim', 'uBright']) this.u[k] = gl.getUniformLocation(pr, k);
      this.env = { light: V3.norm([0.45, 0.85, 0.35]), sky: hex('#fff4e2'), ground: hex('#a8977c'), fog: hex('#efe7d8'), fogN: 22, fogF: 60, bright: 1, clear: hex('#efe7d8') };
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.w = 1; this.h = 1;
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), c = this.canvas;
      const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.w = w; this.h = h; this.gl.viewport(0, 0, w, h);
    }
    upload(m) {
      const gl = this.gl;
      m.buf = { p: gl.createBuffer(), n: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, m.buf.p); gl.bufferData(gl.ARRAY_BUFFER, m.p, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.buf.n); gl.bufferData(gl.ARRAY_BUFFER, m.n, gl.STATIC_DRAW);
    }
    render(scene, cam) {
      const gl = this.gl, u = this.u, e = this.env;
      this.resize();
      const aspect = this.w / this.h;
      cam.update(aspect);
      // 世界矩阵
      const items = [];
      const walk = (n, parentM, vis) => {
        n.world = parentM ? M4.mul(parentM, M4.trs(n.pos, n.rot, n.scl)) : M4.trs(n.pos, n.rot, n.scl);
        const v = vis && n.visible;
        if (v && n.mesh) items.push(n);
        for (const c of n.children) walk(c, n.world, v);
      };
      walk(scene, null, true);
      gl.clearColor(e.clear[0], e.clear[1], e.clear[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(u.uVP, false, cam.vp);
      gl.uniform3fv(u.uLight, e.light); gl.uniform3fv(u.uSky, e.sky); gl.uniform3fv(u.uGround, e.ground); gl.uniform3fv(u.uFog, e.fog);
      gl.uniform3fv(u.uCam, cam.eye); gl.uniform1f(u.uFogN, e.fogN); gl.uniform1f(u.uFogF, e.fogF); gl.uniform1f(u.uBright, e.bright);
      const opaque = [], trans = [];
      for (const n of items) (n.alpha < 0.999 || n.rim > 0 ? trans : opaque).push(n);
      const draw = (n) => {
        const m = n.mesh; if (!m.buf) this.upload(m);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buf.p); gl.enableVertexAttribArray(this.a.p); gl.vertexAttribPointer(this.a.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buf.n); gl.enableVertexAttribArray(this.a.n); gl.vertexAttribPointer(this.a.n, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(u.uM, false, n.world); gl.uniformMatrix3fv(u.uNM, false, M4.normal(n.world));
        gl.uniform3fv(u.uColor, n.color); gl.uniform3fv(u.uEmis, n.emis); gl.uniform1f(u.uAlpha, n.alpha); gl.uniform1f(u.uGrid, n.grid); gl.uniform1f(u.uRim, n.rim);
        gl.drawArrays(gl.TRIANGLES, 0, m.count);
      };
      gl.disable(gl.BLEND); gl.depthMask(true);
      for (const n of opaque) draw(n);
      if (this.splat) { this.splat.draw(cam, this); gl.useProgram(this.pr); }
      if (trans.length) {
        const ce = cam.eye;
        for (const n of trans) { const p = n.worldPos(); n._d = (p[0] - ce[0]) ** 2 + (p[1] - ce[1]) ** 2 + (p[2] - ce[2]) ** 2; }
        trans.sort((a, b) => b._d - a._d);
        gl.enable(gl.BLEND); gl.depthMask(false);
        for (const n of trans) draw(n);
        gl.depthMask(true); gl.disable(gl.BLEND);
      }
      this.items = items;
    }
    // 射线拾取：返回最近的带 pick 的节点（沿父链查找 pick）
    pick(cam, sx, sy) {
      const c = this.canvas, x = (sx / c.clientWidth) * 2 - 1, y = -(sy / c.clientHeight) * 2 + 1;
      const inv = M4.invert(cam.vp), p0 = M4.point(inv, [x, y, -1]), p1 = M4.point(inv, [x, y, 1]);
      let best = null, bestT = Infinity;
      for (const n of this.items || []) {
        let owner = n; while (owner && !owner.pick) owner = owner.parent;
        if (!owner || n.alpha < 0.05 && !n.rim) continue;
        const iw = M4.invert(n.world), o = M4.point(iw, p0), e = M4.point(iw, p1), d = V3.sub(e, o);
        const { min, max } = n.mesh; let t0 = 0, t1 = 1, hit = true;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(d[k]) < 1e-9) { if (o[k] < min[k] || o[k] > max[k]) { hit = false; break; } continue; }
          let ta = (min[k] - o[k]) / d[k], tb = (max[k] - o[k]) / d[k]; if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) { hit = false; break; }
        }
        if (hit && t0 < bestT) { bestT = t0; best = owner; }
      }
      return best;
    }
  }

  // ---------- 轨道相机 ----------
  class Camera {
    constructor() { this.target = [0, 1, 0]; this.yaw = 0.6; this.pitch = 0.3; this.dist = 12; this.fov = 0.82; this.eye = [0, 0, 0]; this.vp = M4.ident(); this.minPitch = 0.04; this.maxPitch = 1.35; }
    update(aspect) {
      const cp = Math.cos(this.pitch);
      this.eye = [this.target[0] + this.dist * cp * Math.sin(this.yaw), this.target[1] + this.dist * Math.sin(this.pitch), this.target[2] + this.dist * cp * Math.cos(this.yaw)];
      this.view = M4.lookAt(this.eye, this.target, [0, 1, 0]);
      this.proj = M4.persp(this.fov, aspect, 0.1, 200);
      this.vp = M4.mul(this.proj, this.view);
    }
    project(p, w, h) {
      const v = this.vp, x = p[0], y = p[1], z = p[2];
      const cx = v[0] * x + v[4] * y + v[8] * z + v[12], cy = v[1] * x + v[5] * y + v[9] * z + v[13], cw = v[3] * x + v[7] * y + v[11] * z + v[15];
      if (cw <= 0.01) return null;
      return { x: (cx / cw * 0.5 + 0.5) * w, y: (1 - (cy / cw * 0.5 + 0.5)) * h, depth: cw };
    }
  }

  function orbitControls(canvas, cam, onTap) {
    let down = null, moved = 0, pinch = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch }; moved = 0; canvas.setPointerCapture?.(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!down || pinch) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y; moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      if (moved > 4) { cam.yaw = down.yaw - dx * 0.006; cam.pitch = Math.min(cam.maxPitch, Math.max(cam.minPitch, down.pitch + dy * 0.004)); cam.userMoved = true; }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (down && moved <= 4 && onTap) { const r = canvas.getBoundingClientRect(); onTap(e.clientX - r.left, e.clientY - r.top); }
      down = null;
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(40, Math.max(2.4, cam.dist * (1 + Math.sign(e.deltaY) * 0.08))); cam.userMoved = true; }, { passive: false });
    canvas.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { const [a, b] = e.touches; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), dist: cam.dist }; } }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { if (pinch && e.touches.length === 2) { const [a, b] = e.touches; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); cam.dist = Math.min(40, Math.max(2.4, pinch.dist * pinch.d / d)); } }, { passive: true });
    canvas.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  }

  // ---------- 补间 ----------
  const ease = { lin: (t) => t, inOut: (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, out: (t) => 1 - Math.pow(1 - t, 3), back: (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
  const tweens = new Set();
  function tween(dur, fn, e = ease.inOut) {
    return new Promise((res) => { const tw = { t: 0, dur: Math.max(0.001, dur), fn, e, res }; tweens.add(tw); fn(0); });
  }
  function stepTweens(dt) {
    for (const tw of [...tweens]) {
      tw.t += dt; const k = Math.min(1, tw.t / tw.dur); tw.fn(tw.e(k));
      if (k >= 1) { tweens.delete(tw); tw.res(); }
    }
  }
  function camTo(cam, v, dur = 1.2) {
    const s = { t: [...cam.target], y: cam.yaw, p: cam.pitch, d: cam.dist };
    let dy = (v.yaw ?? s.y) - s.y; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    cam.userMoved = false;
    return tween(dur, (k) => {
      if (v.target) cam.target = V3.lerp(s.t, v.target, k);
      cam.yaw = s.y + dy * k; if (v.pitch != null) cam.pitch = s.p + (v.pitch - s.p) * k; if (v.dist != null) cam.dist = s.d + (v.dist - s.d) * k;
    });
  }

  G.E = { V3, M4, Prim, Node, Renderer, Camera, orbitControls, tween, stepTweens, camTo, ease, hex };
})(typeof window !== 'undefined' ? window : globalThis);
