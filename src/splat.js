/* 插电工坊 · Marble（World Labs）高斯泼溅场景渲染：读 .spz（v2/v3）/ .ply（3DGS）/ .splat，WebGL2 实例化绘制，按深度排序。
 * 场景作为车间“环境”，可交互的车、零件、人物仍是网格模型叠在上面（网格先画、写深度；泼溅做深度测试、不写深度）。 */
(function (G) {
  'use strict';

  // ---------- 解码 ----------
  async function gunzip(buf) {
    const u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return buf;
    if (typeof DecompressionStream === 'undefined') throw new Error('这个浏览器不支持解压 .spz，请用新版 Edge / Chrome');
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(s).arrayBuffer();
  }
  // 统一输出：n, pos(Float32 n*3), scale(Float32 n*3, 线性), rot(Float32 n*4, xyzw), rgba(Uint8 n*4)
  function parseSpz(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (dv.getUint32(0, true) !== 0x5053474e) throw new Error('不是 SPZ 文件');
    const ver = dv.getUint32(4, true), n = dv.getUint32(8, true), shDeg = u8[12], frac = u8[13];
    if (ver !== 2 && ver !== 3) throw new Error(`这个 SPZ 是第 ${ver} 版，课件目前只读第 2、3 版。请改导出 PLY，或把文件发给开发者适配`);
    if (shDeg > 3) throw new Error(`SPZ 球谐阶数 ${shDeg} 不合法，文件可能损坏`);
    const shDim = [0, 3, 8, 15][shDeg];
    const need = 16 + n * (9 + 1 + 3 + 3 + (ver >= 3 ? 4 : 3) + shDim * 3);
    if (buf.byteLength < need) throw new Error(`SPZ 数据不完整：应有 ${need} 字节，实际 ${buf.byteLength} 字节`);
    let o = 16;
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), rot = new Float32Array(n * 4), rgba = new Uint8Array(n * 4);
    const fs = 1 / (1 << frac);
    for (let i = 0; i < n * 3; i++) { const b = o + i * 3; let v = u8[b] | (u8[b + 1] << 8) | (u8[b + 2] << 16); if (v & 0x800000) v -= 0x1000000; pos[i] = v * fs; }
    o += n * 9;
    for (let i = 0; i < n; i++) rgba[i * 4 + 3] = u8[o + i];
    o += n;
    const C0 = 0.28209479177387814;
    for (let i = 0; i < n * 3; i++) { const dc = (u8[o + i] / 255 - 0.5) / 0.15; const c = 0.5 + C0 * dc; rgba[Math.floor(i / 3) * 4 + (i % 3)] = Math.max(0, Math.min(255, Math.round(c * 255))); }
    o += n * 3;
    for (let i = 0; i < n * 3; i++) scale[i] = Math.exp(u8[o + i] / 16 - 10);
    o += n * 3;
    if (ver >= 3) {
      const mask = (1 << 9) - 1, s12 = Math.SQRT1_2;
      for (let i = 0; i < n; i++) {
        let comp = (u8[o + i * 4] | (u8[o + i * 4 + 1] << 8) | (u8[o + i * 4 + 2] << 16) | (u8[o + i * 4 + 3] << 24)) >>> 0;
        const big = comp >>> 30; const q = [0, 0, 0, 0]; let sum = 0;
        for (let k = 3; k >= 0; k--) { if (k === big) continue; const mag = comp & mask, neg = (comp >>> 9) & 1; comp = comp >>> 10; let v = s12 * mag / mask; if (neg) v = -v; q[k] = v; sum += v * v; }
        q[big] = Math.sqrt(Math.max(0, 1 - sum));
        rot.set(q, i * 4);
      }
      o += n * 4;
    } else {
      for (let i = 0; i < n; i++) {
        const x = u8[o + i * 3] / 127.5 - 1, y = u8[o + i * 3 + 1] / 127.5 - 1, z = u8[o + i * 3 + 2] / 127.5 - 1;
        rot[i * 4] = x; rot[i * 4 + 1] = y; rot[i * 4 + 2] = z; rot[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
      }
      o += n * 3;
    }
    return { n, pos, scale, rot, rgba, format: `SPZ v${ver}`, sh: shDim };
  }
  function parsePly(buf) {
    const u8 = new Uint8Array(buf); let hEnd = -1;
    const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 20000)));
    const k = head.indexOf('end_header'); if (k < 0) throw new Error('PLY 文件头不完整');
    hEnd = new TextEncoder().encode(head.slice(0, k + 'end_header'.length)).length + 1;
    const lines = head.slice(0, k).split(/\r?\n/);
    if (!lines.some((l) => /format binary_little_endian/.test(l))) throw new Error('只支持 binary_little_endian 的 PLY');
    let n = 0; const props = []; let inV = false;
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      if (t[0] === 'element') { inV = t[1] === 'vertex'; if (inV) n = +t[2]; }
      else if (t[0] === 'property' && inV) props.push({ type: t[1], name: t[2] });
    }
    const size = { float: 4, double: 8, uchar: 1, int: 4, uint: 4, short: 2, ushort: 2, char: 1 };
    let stride = 0; const off = {}; for (const p of props) { off[p.name] = { o: stride, t: p.type }; stride += size[p.type]; }
    const dv = new DataView(buf, hEnd);
    const get = (i, name) => { const p = off[name]; if (!p) return 0; const b = i * stride + p.o; return p.t === 'float' ? dv.getFloat32(b, true) : p.t === 'uchar' ? dv.getUint8(b) : p.t === 'double' ? dv.getFloat64(b, true) : dv.getInt32(b, true); };
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), rot = new Float32Array(n * 4), rgba = new Uint8Array(n * 4);
    const C0 = 0.28209479177387814, sig = (x) => 1 / (1 + Math.exp(-x));
    const hasDc = !!off.f_dc_0;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = get(i, 'x'); pos[i * 3 + 1] = get(i, 'y'); pos[i * 3 + 2] = get(i, 'z');
      for (let c = 0; c < 3; c++) {
        const v = hasDc ? 0.5 + C0 * get(i, 'f_dc_' + c) : get(i, ['red', 'green', 'blue'][c]) / 255;
        rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      rgba[i * 4 + 3] = Math.round(255 * (off.opacity ? sig(get(i, 'opacity')) : 1));
      for (let c = 0; c < 3; c++) scale[i * 3 + c] = off.scale_0 ? Math.exp(get(i, 'scale_' + c)) : 0.01;
      const w = off.rot_0 ? get(i, 'rot_0') : 1, x = get(i, 'rot_1'), y = get(i, 'rot_2'), z = get(i, 'rot_3'), L = Math.hypot(w, x, y, z) || 1;
      rot[i * 4] = x / L; rot[i * 4 + 1] = y / L; rot[i * 4 + 2] = z / L; rot[i * 4 + 3] = w / L;
    }
    return { n, pos, scale, rot, rgba, format: 'PLY (3DGS)', sh: 0 };
  }
  function parseSplat(buf) {
    const n = Math.floor(buf.byteLength / 32), f = new Float32Array(buf), u8 = new Uint8Array(buf);
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), rot = new Float32Array(n * 4), rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      pos.set(f.subarray(i * 8, i * 8 + 3), i * 3); scale.set(f.subarray(i * 8 + 3, i * 8 + 6), i * 3);
      rgba.set(u8.subarray(i * 32 + 24, i * 32 + 28), i * 4);
      const w = (u8[i * 32 + 28] - 128) / 128, x = (u8[i * 32 + 29] - 128) / 128, y = (u8[i * 32 + 30] - 128) / 128, z = (u8[i * 32 + 31] - 128) / 128, L = Math.hypot(w, x, y, z) || 1;
      rot[i * 4] = x / L; rot[i * 4 + 1] = y / L; rot[i * 4 + 2] = z / L; rot[i * 4 + 3] = w / L;
    }
    return { n, pos, scale, rot, rgba, format: '.splat', sh: 0 };
  }
  async function decode(buf, name = '') {
    const lower = name.toLowerCase();
    if (lower.endsWith('.ply')) return parsePly(buf);
    if (lower.endsWith('.splat')) return parseSplat(buf);
    const raw = await gunzip(buf);
    return parseSpz(raw);
  }

  // ---------- half float ----------
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function toHalf(v) {
    f32[0] = v; const x = u32[0];
    const sign = (x >> 16) & 0x8000; let e = ((x >> 23) & 0xff) - 127 + 15; let m = x & 0x7fffff;
    if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
    if (e >= 31) return sign | 0x7c00;
    return sign | (e << 10) | ((m + 0x1000) >> 13);
  }
  const pack2 = (a, b) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;

  // ---------- 渲染 ----------
  const VS = `#version 300 es
precision highp float; precision highp int;
uniform highp usampler2D u_tex; uniform mat4 u_proj, u_view; uniform vec2 u_focal, u_viewport; uniform float u_bright;
in vec2 a_pos; in int a_index;
out vec4 v_color; out vec2 v_pos;
void main(){
  uint idx = uint(a_index);
  uvec4 c = texelFetch(u_tex, ivec2(int((idx & 1023u) << 1), int(idx >> 10)), 0);
  vec4 cam = u_view * vec4(uintBitsToFloat(c.xyz), 1.0);
  vec4 p2 = u_proj * cam;
  float clip = 1.2 * p2.w;
  if (cam.z > -0.05 || p2.x < -clip || p2.x > clip || p2.y < -clip || p2.y > clip) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  uvec4 cv = texelFetch(u_tex, ivec2(int(((idx & 1023u) << 1) | 1u), int(idx >> 10)), 0);
  vec2 u1 = unpackHalf2x16(cv.x), u2 = unpackHalf2x16(cv.y), u3 = unpackHalf2x16(cv.z);
  mat3 V = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);
  float z = cam.z;
  mat3 J = mat3(-u_focal.x / z, 0.0, u_focal.x * cam.x / (z * z), 0.0, -u_focal.y / z, u_focal.y * cam.y / (z * z), 0.0, 0.0, 0.0);
  mat3 T = transpose(mat3(u_view)) * J;
  mat3 c2 = transpose(T) * V * T;
  float a = c2[0][0] + 0.3, b = c2[0][1], d = c2[1][1] + 0.3;
  float mid = 0.5 * (a + d), rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 dvec = normalize(vec2(b, l1 - a) + vec2(1e-6, 0.0));
  vec2 major = min(sqrt(l1), 512.0) * dvec, minor = min(sqrt(l2), 512.0) * vec2(dvec.y, -dvec.x);
  v_color = vec4(float(cv.w & 255u), float((cv.w >> 8) & 255u), float((cv.w >> 16) & 255u), float(cv.w >> 24)) / 255.0;
  v_color.rgb *= u_bright;
  v_pos = a_pos;
  vec2 ctr = p2.xy / p2.w;
  vec2 off = (a_pos.x * major + a_pos.y * minor) * 2.0 / u_viewport;
  gl_Position = vec4(ctr + off, p2.z / p2.w, 1.0);
}`;
  const FS = `#version 300 es
precision highp float;
in vec4 v_color; in vec2 v_pos; out vec4 o;
void main(){ float r = dot(v_pos, v_pos); if (r > 6.25) discard; float al = exp(-0.5 * r) * v_color.a; if (al < 0.01) discard; o = vec4(v_color.rgb, al); }`;

  class SplatWorld {
    constructor(gl) {
      if (!(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) throw new Error('需要 WebGL2');
      this.gl = gl;
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      this.pr = pr;
      this.u = {}; for (const k of ['u_tex', 'u_proj', 'u_view', 'u_focal', 'u_viewport', 'u_bright']) this.u[k] = gl.getUniformLocation(pr, k);
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
      const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2.5, -2.5, 2.5, -2.5, 2.5, 2.5, -2.5, 2.5]), gl.STATIC_DRAW);
      const ap = gl.getAttribLocation(pr, 'a_pos'); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      this.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      const ai = gl.getAttribLocation(pr, 'a_index'); gl.enableVertexAttribArray(ai); gl.vertexAttribIPointer(ai, 1, gl.INT, 0, 0); gl.vertexAttribDivisor(ai, 1);
      gl.bindVertexArray(null);
      this.tex = gl.createTexture();
      this.n = 0; this.visible = true; this.bright = 1; this.lastSortView = null; this.order = null;
      this.place = { scale: 1, yaw: 0, flip: true, x: 0, y: 0, z: 0 };
    }
    setData(d) { this.src = d; this.n = d.n; this.apply(); }
    setPlacement(p) { Object.assign(this.place, p); if (this.src) this.apply(); }
    // 把原始泼溅变换到车间坐标，写入数据纹理
    apply() {
      const { n, pos, scale, rot, rgba } = this.src, P = this.place, gl = this.gl;
      const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw), k = P.scale, fl = P.flip ? -1 : 1;
      // A = k * Ry(yaw) * diag(1, fl, fl)
      const A = [k * cy, 0, k * sy * fl, 0, k * fl, 0, -k * sy, 0, k * cy * fl]; // 行主序 3x3
      const W = 1024, H = Math.ceil(n / W);
      const data = new Uint32Array(W * 2 * H * 4), fdata = new Float32Array(data.buffer);
      const wp = this.wpos = new Float32Array(n * 3);
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const X = A[0] * x + A[1] * y + A[2] * z + P.x, Y = A[3] * x + A[4] * y + A[5] * z + P.y, Z = A[6] * x + A[7] * y + A[8] * z + P.z;
        wp[i * 3] = X; wp[i * 3 + 1] = Y; wp[i * 3 + 2] = Z; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
        const qx = rot[i * 4], qy = rot[i * 4 + 1], qz = rot[i * 4 + 2], qw = rot[i * 4 + 3];
        const sx = scale[i * 3], s2 = scale[i * 3 + 1], sz = scale[i * 3 + 2];
        // R（行主序）
        const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
        const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
        const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
        // M = A * R * S
        const m00 = (A[0] * r00 + A[1] * r10 + A[2] * r20) * sx, m01 = (A[0] * r01 + A[1] * r11 + A[2] * r21) * s2, m02 = (A[0] * r02 + A[1] * r12 + A[2] * r22) * sz;
        const m10 = (A[3] * r00 + A[4] * r10 + A[5] * r20) * sx, m11 = (A[3] * r01 + A[4] * r11 + A[5] * r21) * s2, m12 = (A[3] * r02 + A[4] * r12 + A[5] * r22) * sz;
        const m20 = (A[6] * r00 + A[7] * r10 + A[8] * r20) * sx, m21 = (A[6] * r01 + A[7] * r11 + A[8] * r21) * s2, m22 = (A[6] * r02 + A[7] * r12 + A[8] * r22) * sz;
        const c00 = m00 * m00 + m01 * m01 + m02 * m02, c01 = m00 * m10 + m01 * m11 + m02 * m12, c02 = m00 * m20 + m01 * m21 + m02 * m22;
        const c11 = m10 * m10 + m11 * m11 + m12 * m12, c12 = m10 * m20 + m11 * m21 + m12 * m22, c22 = m20 * m20 + m21 * m21 + m22 * m22;
        const t = (Math.floor(i / W) * W * 2 + (i % W) * 2) * 4;
        fdata[t] = X; fdata[t + 1] = Y; fdata[t + 2] = Z;
        data[t + 3] = (rgba[i * 4] | (rgba[i * 4 + 1] << 8) | (rgba[i * 4 + 2] << 16) | (rgba[i * 4 + 3] << 24)) >>> 0;
        data[t + 4] = pack2(c00, c01); data[t + 5] = pack2(c02, c11); data[t + 6] = pack2(c12, c22); data[t + 7] = data[t + 3];
      }
      this.minY = minY; this.maxY = maxY;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, W * 2, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
      this.lastSortView = null; this.depths = new Float32Array(n); this.order = new Int32Array(n); this.counts = new Uint32Array(65536); this.starts = new Uint32Array(65536);
    }
    // 抽样统计变换后的分布（用来自动对齐地面和房间中心）
    stats() {
      const n = this.n, wp = this.wpos, step = Math.max(1, Math.floor(n / 40000)), xs = [], ys = [], zs = [];
      for (let i = 0; i < n; i += step) { xs.push(wp[i * 3]); ys.push(wp[i * 3 + 1]); zs.push(wp[i * 3 + 2]); }
      const q = (a, p) => { a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))]; };
      return { x5: q(xs, 0.05), x95: q(xs, 0.95), y3: q(ys, 0.03), y97: q(ys, 0.97), z5: q(zs, 0.05), z95: q(zs, 0.95) };
    }
    // 由远到近排序（16 位计数排序）
    sort(view) {
      const n = this.n, wp = this.wpos, d = this.depths;
      const v2 = view[2], v6 = view[6], v10 = view[10], v14 = view[14];
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const z = v2 * wp[i * 3] + v6 * wp[i * 3 + 1] + v10 * wp[i * 3 + 2] + v14; d[i] = z; if (z < lo) lo = z; if (z > hi) hi = z; }
      const counts = this.counts, starts = this.starts; counts.fill(0);
      const k = 65535 / ((hi - lo) || 1), key = new Uint16Array(n);
      for (let i = 0; i < n; i++) { const b = ((d[i] - lo) * k) | 0; key[i] = b; counts[b]++; }
      starts[0] = 0; for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
      const ord = this.order; for (let i = 0; i < n; i++) ord[starts[key[i]]++] = i;
      const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf); gl.bufferData(gl.ARRAY_BUFFER, ord, gl.DYNAMIC_DRAW);
      this.lastSortView = view.slice();
    }
    draw(cam, R) {
      if (!this.n || !this.visible) return;
      const gl = this.gl, v = cam.view;
      const lv = this.lastSortView;
      if (!lv || Math.abs(lv[2] - v[2]) + Math.abs(lv[6] - v[6]) + Math.abs(lv[10] - v[10]) > 0.01 || Math.abs(lv[14] - v[14]) > 0.15) {
        if (!this._t || performance.now() - this._t > 90 || !lv) { this.sort(v); this._t = performance.now(); }
      }
      gl.useProgram(this.pr); gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.u.u_tex, 0);
      gl.uniformMatrix4fv(this.u.u_proj, false, cam.proj); gl.uniformMatrix4fv(this.u.u_view, false, v);
      const fy = R.h / 2 / Math.tan(cam.fov / 2);
      gl.uniform2f(this.u.u_focal, fy, fy); gl.uniform2f(this.u.u_viewport, R.w, R.h); gl.uniform1f(this.u.u_bright, this.bright);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.n);
      gl.bindVertexArray(null); gl.depthMask(true); gl.disable(gl.BLEND);
      gl.useProgram(R.pr);
    }
  }

  G.CDG_SPLAT = { decode, parseSpz, parsePly, parseSplat, gunzip, SplatWorld, toHalf };
  if (typeof module !== 'undefined') module.exports = G.CDG_SPLAT;
})(typeof window !== 'undefined' ? window : globalThis);
