/* 插电工坊 · Marble（World Labs）高斯泼溅场景渲染：读 .spz（v2/v3）/ .ply（3DGS）/ .splat，WebGL2 实例化绘制，按深度排序。
 * 场景作为车间“环境”，可交互的车、零件、人物仍是网格模型叠在上面（网格先画、写深度；泼溅做深度测试、不写深度）。 */
(function (G) {
  'use strict';
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const LIMITS = Object.freeze({ inputBytes: 128 * 1024 * 1024, decodedBytes: 128 * 1024 * 1024, sourcePoints: 2000000, activePoints: 500000, defaultBudget: 100000 });
  function integer(value, name, min = 1, max = 10000000) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须为 ${min}–${max} 的整数`); return value; }

  // ---------- 解码 ----------
  async function gunzip(buf, maxBytes = LIMITS.decodedBytes) {
    integer(maxBytes, 'maxDecodedBytes', 16, 512 * 1024 * 1024);
    const u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) { if (buf.byteLength > maxBytes) throw new Error('SPZ 解码字节数超过预算'); return buf; }
    if (typeof DecompressionStream === 'undefined') throw new Error('这个浏览器不支持解压 .spz，请用新版 Edge / Chrome');
    const reader = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('SPZ 解压字节数超过预算'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    return raw.buffer;
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
  async function decode(buf, name = '', options = {}) {
    const started = now(), lower = name.toLowerCase(), maxInput = options.maxInputBytes ?? LIMITS.inputBytes, maxRaw = options.maxDecodedBytes ?? LIMITS.decodedBytes;
    integer(maxInput, 'maxInputBytes', 16, 512 * 1024 * 1024); integer(maxRaw, 'maxDecodedBytes', 16, 512 * 1024 * 1024);
    const maxPoints = integer(options.maxSourcePoints ?? LIMITS.sourcePoints, 'maxSourcePoints');
    if (Object.prototype.toString.call(buf) !== '[object ArrayBuffer]') throw new Error('点云输入必须是 ArrayBuffer');
    if (buf.byteLength > maxInput) throw new Error('点云输入字节数超过预算');
    const progress = (phase, detail = {}) => options.onProgress?.({ phase, inputBytes: buf.byteLength, elapsedMs: now() - started, ...detail });
    progress('decode'); let d, rawBytes = buf.byteLength;
    if ((lower.endsWith('.ply') || lower.endsWith('.splat')) && buf.byteLength > maxRaw) throw new Error('点云解码字节数超过预算');
    if (lower.endsWith('.ply')) {
      const h = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 20000)));
      const m = h.match(/(?:^|\n)element vertex (\d+)/); if (!m || +m[1] > maxPoints) throw new Error('PLY 顶点数无效或超过预算');
      d = parsePly(buf);
    } else if (lower.endsWith('.splat')) {
      if (!buf.byteLength || buf.byteLength % 32 || buf.byteLength / 32 > maxPoints) throw new Error('.splat 点数或字节长度无效/超过预算');
      d = parseSplat(buf);
    } else {
      progress('decompress'); const raw = await gunzip(buf, maxRaw); rawBytes = raw.byteLength;
      if (raw.byteLength < 16 || new DataView(raw).getUint32(8, true) > maxPoints) throw new Error('SPZ 点数无效或超过预算');
      progress('decode'); d = parseSpz(raw);
    }
    d.loadMetadata = { inputBytes: buf.byteLength, decodedBytes: rawBytes, decodeMs: now() - started, sourcePoints: d.n, format: d.format };
    progress('decoded', d.loadMetadata); return d;
  }

  // ---------- Spatial progressive LOD ----------
  // First cover every occupied octant, then every occupied 4³/8³/16³/32³ region.
  // Once each 32³ cell has a representative, round-robin its remaining points.
  // Every budget is a prefix of one immutable order, independent of camera depth.
  const GRID_BITS = 5, CELLS = 1 << (3 * GRID_BITS);
  function reverseBits(x) { x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1); x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2); x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4); x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8); return ((x >>> 16) | (x << 16)) >>> 0; }
  function cellOf(pos, i, bounds) {
    let code = 0;
    for (let axis = 0; axis < 3; axis++) {
      const span = bounds.max[axis] - bounds.min[axis];
      const q = span ? Math.max(0, Math.min(31, Math.floor((pos[i * 3 + axis] - bounds.min[axis]) / span * 32))) : 0;
      for (let b = 0; b < GRID_BITS; b++) code |= ((q >>> b) & 1) << (b * 3 + axis);
    }
    return code;
  }
  function createLOD(d, options = {}) {
    const started = now(), max = integer(options.maxSourcePoints ?? LIMITS.sourcePoints, 'maxSourcePoints');
    if (!d) throw new Error('需要点云数据'); const n = integer(d.n, 'sourcePoints', 1, max);
    for (const [key, count, ctor] of [['pos', 3, Float32Array], ['scale', 3, Float32Array], ['rot', 4, Float32Array], ['rgba', 4, Uint8Array]]) {
      if (!(d[key] instanceof ctor) || d[key].length !== n * count) throw new Error(`点云 ${key} 类型/数量不匹配`);
    }
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < n; i++) {
      let q = 0;
      for (let a = 0; a < 3; a++) { const v = d.pos[i * 3 + a], s = d.scale[i * 3 + a]; if (!Number.isFinite(v) || !Number.isFinite(s) || s < 0) throw new Error('点云位置/尺度非有限或负尺度'); bounds.min[a] = Math.min(bounds.min[a], v); bounds.max[a] = Math.max(bounds.max[a], v); }
      for (let a = 0; a < 4; a++) { const r = d.rot[i * 4 + a]; if (!Number.isFinite(r)) throw new Error('点云旋转非有限'); q += r * r; } if (!(q > 0)) throw new Error('点云旋转为零');
    }
    const counts = new Uint32Array(CELLS), starts = new Uint32Array(CELLS + 1);
    for (let i = 0; i < n; i++) counts[cellOf(d.pos, i, bounds)]++;
    let occupied = 0, octants = 0; const octantMask = new Uint8Array(8);
    for (let c = 0; c < CELLS; c++) { starts[c + 1] = starts[c] + counts[c]; if (counts[c]) { occupied++; octantMask[c >>> 12] = 1; } }
    for (const yes of octantMask) octants += yes;
    const cells = new Uint16Array(occupied); let ci = 0;
    for (let c = 0; c < CELLS; c++) if (counts[c]) cells[ci++] = c;
    const cursor = starts.slice(0, CELLS), grouped = new Uint32Array(n);
    // Bit-reversal distributes original-file neighbors without a comparator sort or boxed N-element arrays.
    const bits = Math.ceil(Math.log2(n)), domain = 2 ** bits;
    for (let k = 0; k < domain; k++) { const i = bits ? reverseBits(k) >>> (32 - bits) : 0; if (i < n) grouped[cursor[cellOf(d.pos, i, bounds)]++] = i; }
    // Prefer a visible representative; never let a transparent point stand in for opaque neighbors.
    for (const c of cells) {
      const first = starts[c]; let best = first;
      for (let p = first + 1; p < starts[c + 1]; p++) if (d.rgba[grouped[p] * 4 + 3] > d.rgba[grouped[best] * 4 + 3]) best = p;
      const swap = grouped[first]; grouped[first] = grouped[best]; grouped[best] = swap;
    }
    const represented = new Uint8Array(CELLS), cellOrder = new Uint16Array(occupied); let used = 0;
    for (let depth = 1; depth <= GRID_BITS; depth++) {
      const shift = 3 * (GRID_BITS - depth);
      for (let from = 0; from < cells.length;) {
        let end = from + 1, has = !!represented[cells[from]]; const prefix = cells[from] >>> shift;
        while (end < cells.length && cells[end] >>> shift === prefix) { has ||= !!represented[cells[end]]; end++; }
        if (!has) { const c = cells[(from + end - 1) >>> 1]; represented[c] = 1; cellOrder[used++] = c; }
        from = end;
      }
    }
    cursor.set(starts.subarray(0, CELLS));
    const order = new Uint32Array(n); let active = occupied, at = 0;
    while (active) {
      let next = 0;
      for (let k = 0; k < active; k++) { const c = cellOrder[k]; order[at++] = grouped[cursor[c]++]; if (cursor[c] < starts[c + 1]) cellOrder[next++] = c; }
      active = next;
    }
    return { order, bounds, sourcePoints: n, occupiedCells: occupied, occupiedOctants: octants, grid: 32, algorithm: 'hierarchical-grid-prefix-v1', selectionMs: now() - started, persistentBytes: order.byteLength,
      // Peak auxiliary allocation, excluding caller-owned source arrays. Typed arrays above are released after construction.
      buildPeakBytes: order.byteLength + grouped.byteLength + counts.byteLength + starts.byteLength + cursor.byteLength + cells.byteLength + cellOrder.byteLength + represented.byteLength + octantMask.byteLength };
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
    constructor(gl, options = {}) {
      if (!(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) throw new Error('需要 WebGL2');
      this.gl = gl;
      this.maxActivePoints = integer(options.maxActivePoints ?? LIMITS.activePoints, 'maxActivePoints');
      this.maxSourcePoints = integer(options.maxSourcePoints ?? LIMITS.sourcePoints, 'maxSourcePoints');
      this.pointBudget = integer(options.pointBudget ?? LIMITS.defaultBudget, 'pointBudget');
      this.onProgress = options.onProgress || null; this.onMetadata = options.onMetadata || null;
      this._capacity = 0; this._packed = null; this._disposed = false; this._loadId = 0; this.metadata = { phase: 'empty', sourcePoints: 0, activePoints: 0 };
      this.autoLOD = { enabled: false, targetMs: 1000 / 30, minPoints: 25000, window: 45, slowWindows: 2, cooldownFrames: 180, factor: 0.75 };
      this._auto = { frames: 0, sum: 0, slow: 0, cooldown: 0, lastMeanMs: null };
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(), vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      this.pr = pr;
      this.u = {}; for (const k of ['u_tex', 'u_proj', 'u_view', 'u_focal', 'u_viewport', 'u_bright']) this.u[k] = gl.getUniformLocation(pr, k);
      this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
      const quad = this.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2.5, -2.5, 2.5, -2.5, 2.5, 2.5, -2.5, 2.5]), gl.STATIC_DRAW);
      const ap = gl.getAttribLocation(pr, 'a_pos'); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      this.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      const ai = gl.getAttribLocation(pr, 'a_index'); gl.enableVertexAttribArray(ai); gl.vertexAttribIPointer(ai, 1, gl.INT, 0, 0); gl.vertexAttribDivisor(ai, 1);
      gl.bindVertexArray(null);
      this.tex = gl.createTexture();
      this.n = 0; this.visible = true; this.bright = 1; this.lastSortView = null; this.order = null;
      this.place = { scale: 1, yaw: 0, flip: true, x: 0, y: 0, z: 0 };
    }
    _check() { if (this._disposed) throw new Error('SplatWorld 已释放'); }
    _progress(phase) { this.metadata.phase = phase; this.onProgress?.(this.getMetadata()); }
    _publish() { this.onMetadata?.(this.getMetadata()); }
    setData(d, options = {}) {
      this._check(); this._loadId++; const started = now();
      const budget = integer(options.pointBudget ?? this.pointBudget, 'pointBudget');
      if (options.onProgress !== undefined) this.onProgress = options.onProgress;
      this._progress('select');
      let lod;
      try { lod = createLOD(d, { maxSourcePoints: this.maxSourcePoints }); }
      catch (error) { this.metadata.phase = this.src ? 'ready' : 'error'; this.metadata.error = error.message; this._publish(); throw error; }
      // Retain one original cloud and one progressive index. No per-tier attribute copies.
      this.src = d; this.lod = lod; this.pointBudget = budget;
      this.metadata = { ...d.loadMetadata, phase: 'pack', sourcePoints: d.n, format: d.format || 'decoded', selectionMs: lod.selectionMs, loadMs: 0, lastBudgetReason: 'load' };
      this._auto = { frames: 0, sum: 0, slow: 0, cooldown: 0, lastMeanMs: null };
      this._progress('pack'); this.apply(); this.metadata.loadMs = now() - started + (d.loadMetadata?.decodeMs || 0);
      this.metadata.phase = 'ready'; this._progress('ready'); this._publish(); return this.getMetadata();
    }
    async load(buf, name, options = {}) {
      this._check(); const loadId = ++this._loadId, onProgress = options.onProgress || this.onProgress;
      const current = () => { this._check(); if (this._loadId !== loadId) throw new Error('点云加载已被较新的请求替换'); };
      // Yield between heavy phases so a loader can present progress. Parsing itself remains on the caller's thread.
      onProgress?.({ phase: 'loading', inputBytes: buf.byteLength }); await new Promise(r => setTimeout(r, 0));
      current(); const d = await decode(buf, name, { ...options, maxSourcePoints: this.maxSourcePoints, onProgress: (event) => { current(); onProgress?.(event); } });
      await new Promise(r => setTimeout(r, 0)); current(); return this.setData(d, { ...options, onProgress });
    }
    setPointBudget(points) {
      this._check(); this.pointBudget = integer(points, 'pointBudget');
      this.metadata.lastBudgetReason = 'manual';
      this._auto = { frames: 0, sum: 0, slow: 0, cooldown: this.autoLOD.cooldownFrames, lastMeanMs: null };
      if (this.src) { this._progress('pack'); this.apply(); this._progress('ready'); this._publish(); }
      return this.getMetadata();
    }
    setAutoLOD(config = {}) {
      const a = { ...this.autoLOD, ...config };
      if (typeof a.enabled !== 'boolean' || !Number.isFinite(a.targetMs) || a.targetMs < 8 || a.targetMs > 100 || !Number.isFinite(a.factor) || a.factor < 0.25 || a.factor >= 1) throw new Error('Auto LOD 参数无效');
      integer(a.minPoints, 'minPoints'); integer(a.window, 'window', 5, 600); integer(a.slowWindows, 'slowWindows', 1, 20); integer(a.cooldownFrames, 'cooldownFrames', 0, 3600);
      this.autoLOD = a; this._auto = { frames: 0, sum: 0, slow: 0, cooldown: 0, lastMeanMs: null }; return { ...a };
    }
    observeFrame(ms) {
      if (!this.autoLOD.enabled || !this.visible || !this.n || !Number.isFinite(ms) || ms <= 0 || ms > 250) return false;
      const s = this._auto, a = this.autoLOD;
      if (s.cooldown > 0) { s.cooldown--; return false; }
      s.sum += ms; if (++s.frames < a.window) return false;
      s.lastMeanMs = s.sum / s.frames; s.frames = 0; s.sum = 0;
      s.slow = s.lastMeanMs > a.targetMs * 1.2 ? s.slow + 1 : 0;
      if (s.slow < a.slowWindows || this.n <= a.minPoints) return false;
      const next = Math.max(a.minPoints, Math.floor(this.n * a.factor)), mean = s.lastMeanMs;
      this.setPointBudget(next); this._auto.lastMeanMs = mean; this.metadata.lastBudgetReason = 'sustained-frame-time'; this._publish(); return true;
    }
    getSelection() { return this.lod ? this.lod.order.slice(0, this.n) : new Uint32Array(0); }
    getMetadata() {
      const sourceBytes = this.src ? this.src.pos.byteLength + this.src.scale.byteLength + this.src.rot.byteLength + this.src.rgba.byteLength : 0;
      const cpuWorkingBytes = ['wpos', 'depths', 'order', 'keys', 'counts', 'starts', '_packed'].reduce((s, k) => s + (this[k]?.byteLength || 0), 0);
      return { ...this.metadata, sourcePoints: this.src?.n || 0, activePoints: this.n || 0, requestedBudget: this.pointBudget, maxActivePoints: this.maxActivePoints, allocatedPointCapacity: this._capacity,
        selection: this.lod ? { algorithm: this.lod.algorithm, grid: this.lod.grid, occupiedCells: this.lod.occupiedCells, coveredCells: Math.min(this.n, this.lod.occupiedCells), occupiedOctants: this.lod.occupiedOctants, coveredOctants: Math.min(this.n, this.lod.occupiedOctants), bounds: { min: [...this.lod.bounds.min], max: [...this.lod.bounds.max] } } : null,
        memory: { sourceBytes, indexBytes: this.lod?.persistentBytes || 0, selectionBuildPeakBytes: this.lod?.buildPeakBytes || 0, cpuWorkingBytes, gpuTextureBytes: this._gpuTextureBytes || 0, gpuIndexBytes: this._capacity * 4 },
        autoLOD: { ...this.autoLOD, lastMeanMs: this._auto.lastMeanMs, cooldownRemaining: this._auto.cooldown } };
    }
    setPlacement(p) {
      this._check(); const next = { ...this.place, ...p };
      for (const k of ['scale', 'yaw', 'x', 'y', 'z']) if (!Number.isFinite(next[k])) throw new Error('场景变换必须是有限数字');
      if (!(next.scale > 0)) throw new Error('场景缩放必须大于零');
      this.place = next; if (this.src) { this.apply(); this._publish(); }
    }
    // 把原始泼溅变换到车间坐标，写入数据纹理
    apply() {
      const started = now(), { pos, scale, rot, rgba } = this.src, P = this.place, gl = this.gl;
      const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (!Number.isInteger(maxTexture) || maxTexture < 2048) throw new Error('数据纹理需要至少 2048 像素宽度');
      const n = this.n = Math.min(this.src.n, this.pointBudget, this.maxActivePoints, maxTexture * 1024);
      const cy = Math.cos(P.yaw), sy = Math.sin(P.yaw), k = P.scale, fl = P.flip ? -1 : 1;
      // A = k * Ry(yaw) * diag(1, fl, fl)
      const A = [k * cy, 0, k * sy * fl, 0, k * fl, 0, -k * sy, 0, k * cy * fl]; // 行主序 3x3
      const W = 1024, H = Math.ceil(n / W);
      if (n > this._capacity) {
        this._capacity = n; this.wpos = new Float32Array(n * 3); this.depths = new Float32Array(n); this.order = new Int32Array(n); this.keys = new Uint16Array(n);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf); gl.bufferData(gl.ARRAY_BUFFER, n * 4, gl.DYNAMIC_DRAW);
      }
      if (!this._packed || this._packed.length < W * 2 * H * 4) this._packed = new Uint32Array(W * 2 * H * 4);
      const data = this._packed.subarray(0, W * 2 * H * 4), fdata = new Float32Array(data.buffer, data.byteOffset, data.length), wp = this.wpos;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const j = this.lod.order[i];
        const x = pos[j * 3], y = pos[j * 3 + 1], z = pos[j * 3 + 2];
        const X = A[0] * x + A[1] * y + A[2] * z + P.x, Y = A[3] * x + A[4] * y + A[5] * z + P.y, Z = A[6] * x + A[7] * y + A[8] * z + P.z;
        wp[i * 3] = X; wp[i * 3 + 1] = Y; wp[i * 3 + 2] = Z; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
        const qx = rot[j * 4], qy = rot[j * 4 + 1], qz = rot[j * 4 + 2], qw = rot[j * 4 + 3];
        const sx = scale[j * 3], s2 = scale[j * 3 + 1], sz = scale[j * 3 + 2];
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
        data[t + 3] = (rgba[j * 4] | (rgba[j * 4 + 1] << 8) | (rgba[j * 4 + 2] << 16) | (rgba[j * 4 + 3] << 24)) >>> 0;
        data[t + 4] = pack2(c00, c01); data[t + 5] = pack2(c02, c11); data[t + 6] = pack2(c12, c22); data[t + 7] = data[t + 3];
      }
      this.minY = minY; this.maxY = maxY;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, W * 2, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
      this._gpuTextureBytes = data.byteLength;
      this.lastSortView = null; this.counts ||= new Uint32Array(65536); this.starts ||= new Uint32Array(65536);
      this.metadata.packMs = now() - started;
    }
    // 抽样统计变换后的分布（用来自动对齐地面和房间中心）
    stats() {
      if (!this.src) return null;
      // Fixed source sample: changing quality never moves the inferred room/ground.
      const n = Math.min(40000, this.src.n), P = this.place, cy = Math.cos(P.yaw), sy = Math.sin(P.yaw), fl = P.flip ? -1 : 1, xs = [], ys = [], zs = [];
      for (let i = 0; i < n; i++) { const j = this.lod.order[i], x = this.src.pos[j * 3], y = this.src.pos[j * 3 + 1], z = this.src.pos[j * 3 + 2]; xs.push(P.scale * (cy * x + sy * fl * z) + P.x); ys.push(P.scale * fl * y + P.y); zs.push(P.scale * (-sy * x + cy * fl * z) + P.z); }
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
      const k = 65535 / ((hi - lo) || 1), key = this.keys;
      for (let i = 0; i < n; i++) { const b = ((d[i] - lo) * k) | 0; key[i] = b; counts[b]++; }
      starts[0] = 0; for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
      const ord = this.order; for (let i = 0; i < n; i++) ord[starts[key[i]]++] = i;
      const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ord.subarray(0, n));
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
    dispose() {
      if (this._disposed) return; const gl = this.gl;
      gl.deleteTexture(this.tex); gl.deleteBuffer(this.ibuf); gl.deleteBuffer(this.quad); gl.deleteVertexArray(this.vao); gl.deleteProgram(this.pr);
      this.src = this.lod = this.wpos = this.depths = this.order = this.keys = this.counts = this.starts = this._packed = null;
      this.n = this._capacity = this._gpuTextureBytes = 0; this._loadId++; this._disposed = true; this.metadata = { phase: 'disposed' };
    }
  }

  G.CDG_SPLAT = { decode, parseSpz, parsePly, parseSplat, gunzip, SplatWorld, toHalf, createLOD, LIMITS };
  if (typeof module !== 'undefined') module.exports = G.CDG_SPLAT;
})(typeof window !== 'undefined' ? window : globalThis);
