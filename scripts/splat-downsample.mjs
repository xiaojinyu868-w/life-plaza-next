import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Use the classroom's decoder for SPZ and .splat without changing its browser API.
const source = await fs.readFile(new URL('../src/splat.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, TextDecoder, TextEncoder, Blob, Response, DecompressionStream };
vm.runInNewContext(source, sandbox, { filename: 'src/splat.js' });
const decoder = sandbox.module.exports;
export const LIMITS = Object.freeze({ bytes: 512 * 1024 * 1024, points: 10_000_000, headerBytes: 1024 * 1024 });
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function pointCount(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMITS.points) throw new Error(`Point count must be 1..${LIMITS.points}`);
  return n;
}

// Supports scalar properties in the usual 3DGS PLY files, plus RGB point clouds.
// A strict reader here also handles CRLF headers and 16-bit integer properties,
// which the original browser PLY reader does not reliably decode.
export function decodePly(bytes) {
  const ending = /(?:^|\n)end_header\r?\n/.exec(bytes.subarray(0, LIMITS.headerBytes).toString('ascii'));
  if (!ending) throw new Error('PLY header is missing or too large');
  const offset = ending.index + ending[0].length;
  const lines = bytes.subarray(0, offset).toString('ascii').split(/\r?\n/);
  if (lines[0] !== 'ply') throw new Error('Not a PLY file');
  const format = lines.find((line) => line.startsWith('format '))?.split(/\s+/)[1];
  if (!['binary_little_endian', 'ascii'].includes(format)) throw new Error('PLY must be ASCII or binary_little_endian');
  const types = {
    char: ['getInt8', 1], int8: ['getInt8', 1], uchar: ['getUint8', 1], uint8: ['getUint8', 1],
    short: ['getInt16', 2], int16: ['getInt16', 2], ushort: ['getUint16', 2], uint16: ['getUint16', 2],
    int: ['getInt32', 4], int32: ['getInt32', 4], uint: ['getUint32', 4], uint32: ['getUint32', 4],
    float: ['getFloat32', 4], float32: ['getFloat32', 4], double: ['getFloat64', 8], float64: ['getFloat64', 8],
  };
  let n, current, stride = 0, earlierElements = false;
  const props = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') {
      current = parts[1];
      if (current === 'vertex') {
        if (earlierElements || n !== undefined) throw new Error('PLY vertex must be the first nonempty element');
        n = pointCount(Number(parts[2]));
      } else if (n === undefined && Number(parts[2]) > 0) earlierElements = true;
    } else if (parts[0] === 'property' && current === 'vertex') {
      if (!types[parts[1]] || parts.length !== 3) throw new Error('Unsupported PLY vertex property');
      if (props.some((p) => p.name === parts[2])) throw new Error('Duplicate PLY vertex property');
      props.push({ name: parts[2], type: parts[1], offset: stride });
      stride += types[parts[1]][1];
    }
  }
  pointCount(n);
  const names = new Set(props.map((p) => p.name));
  for (const name of ['x', 'y', 'z']) if (!names.has(name)) throw new Error(`PLY is missing ${name}`);
  const dc = ['f_dc_0', 'f_dc_1', 'f_dc_2'].every((s) => names.has(s));
  if (!dc && !['red', 'green', 'blue'].every((s) => names.has(s))) throw new Error('PLY has no complete RGB or SH DC color');
  for (const group of [['scale_0', 'scale_1', 'scale_2'], ['rot_0', 'rot_1', 'rot_2', 'rot_3']]) {
    if (group.some((s) => names.has(s)) && !group.every((s) => names.has(s))) throw new Error('Incomplete PLY scale/rotation');
  }
  const d = allocate(n, 'PLY');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let asciiCursor = offset;
  if (format === 'binary_little_endian' && offset + stride * n > bytes.byteLength) throw new Error('Truncated PLY vertex data');
  for (let i = 0; i < n; i++) {
    const row = {};
    if (format === 'ascii') {
      while (asciiCursor < bytes.length && bytes[asciiCursor] <= 32) asciiCursor++;
      let end = bytes.indexOf(10, asciiCursor);
      if (end === -1) end = bytes.length;
      const values = bytes.subarray(asciiCursor, end).toString('ascii').trim().split(/\s+/).map(Number);
      if (values.length !== props.length || values.some((v) => !Number.isFinite(v))) throw new Error(`Invalid PLY vertex ${i}`);
      props.forEach((p, k) => { row[p.name] = values[k]; });
      asciiCursor = end + 1;
    } else for (const p of props) {
      row[p.name] = view[types[p.type][0]](offset + i * stride + p.offset, true);
      if (!Number.isFinite(row[p.name])) throw new Error(`Invalid PLY ${p.name} at ${i}`);
    }
    for (let c = 0; c < 3; c++) {
      d.pos[i * 3 + c] = row[['x', 'y', 'z'][c]];
      d.scale[i * 3 + c] = names.has('scale_0') ? Math.exp(row[`scale_${c}`]) : 0.01;
      const rgb = dc ? (0.5 + 0.28209479177387814 * row[`f_dc_${c}`]) * 255 : row[['red', 'green', 'blue'][c]];
      if (!Number.isFinite(rgb)) throw new Error(`Invalid PLY color at ${i}`);
      d.rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round(rgb)));
    }
    const alpha = names.has('opacity') ? 255 / (1 + Math.exp(-row.opacity)) : (row.alpha ?? 255);
    if (!Number.isFinite(alpha)) throw new Error(`Invalid PLY opacity at ${i}`);
    d.rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    d.rot.set(names.has('rot_0') ? [row.rot_1, row.rot_2, row.rot_3, row.rot_0] : [0, 0, 0, 1], i * 4);
  }
  d.sh = props.filter((p) => p.name.startsWith('f_rest_')).length / 3;
  return validateCloud(d);
}

function allocate(n, format) {
  return { n, format, pos: new Float32Array(n * 3), scale: new Float32Array(n * 3), rot: new Float32Array(n * 4), rgba: new Uint8Array(n * 4), sh: 0 };
}

export function validateCloud(d) {
  pointCount(d.n);
  for (const [key, width] of [['pos', 3], ['scale', 3], ['rot', 4], ['rgba', 4]]) {
    if (!d[key] || d[key].length !== d.n * width) throw new Error(`Invalid ${key} length`);
  }
  for (let i = 0; i < d.n; i++) {
    for (let c = 0; c < 3; c++) {
      if (!Number.isFinite(d.pos[i * 3 + c])) throw new Error(`Non-finite position at ${i}`);
      if (!Number.isFinite(d.scale[i * 3 + c]) || d.scale[i * 3 + c] <= 0) throw new Error(`Invalid scale at ${i}`);
    }
    const q = d.rot.subarray(i * 4, i * 4 + 4), length = Math.hypot(...q);
    if (!Number.isFinite(length) || length < 1e-8) throw new Error(`Invalid quaternion at ${i}`);
  }
  return d;
}

export async function decodeFile(bytes, name) {
  if (bytes.byteLength > LIMITS.bytes) throw new Error('Input exceeds 512 MiB');
  const ext = path.extname(name).toLowerCase();
  if (ext === '.ply') return decodePly(bytes);
  if (ext === '.splat') {
    if (!bytes.length || bytes.length % 32) throw new Error('SPLAT length must be a nonzero multiple of 32');
    pointCount(bytes.length / 32);
    return validateCloud(decoder.parseSplat(toArrayBuffer(bytes)));
  }
  if (ext !== '.spz') throw new Error('Expected .spz, .ply, or .splat');
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: LIMITS.bytes }) : bytes;
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x5053474e) throw new Error('Invalid SPZ header');
  pointCount(raw.readUInt32LE(8));
  if (![2, 3].includes(raw.readUInt32LE(4))) throw new Error('Only SPZ format v2/v3 is supported; export PLY for other versions');
  if (raw[13] > 24) throw new Error('Invalid SPZ fractionalBits');
  return validateCloud(decoder.parseSpz(toArrayBuffer(raw)));
}

function spreadBits(value) {
  let v = value & 1023;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  return (v | (v << 2)) & 0x09249249;
}

// Spatially ordered systematic sampling: exact count, independent of input block
// ordering, no random seed, no averaging of unrelated Gaussian attributes.
export function selectIndices(d, requested) {
  pointCount(requested);
  const count = Math.min(requested, d.n);
  if (count === d.n) return Uint32Array.from({ length: d.n }, (_, i) => i);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.n; i++) for (let c = 0; c < 3; c++) {
    const v = d.pos[i * 3 + c]; min[c] = Math.min(min[c], v); max[c] = Math.max(max[c], v);
  }
  const keys = new Uint32Array(d.n), order = Uint32Array.from({ length: d.n }, (_, i) => i);
  for (let i = 0; i < d.n; i++) {
    let key = 0;
    for (let c = 0; c < 3; c++) {
      const q = Math.max(0, Math.min(1023, Math.round((d.pos[i * 3 + c] - min[c]) / (max[c] - min[c] || 1) * 1023)));
      key |= spreadBits(q) << c;
    }
    keys[i] = key >>> 0;
  }
  order.sort((a, b) => keys[a] - keys[b] || a - b);
  return Uint32Array.from({ length: count }, (_, i) => order[Math.floor((i + 0.5) * d.n / count)]);
}

export function encodeSplat(d, indices) {
  const b = Buffer.alloc(indices.length * 32);
  indices.forEach((id, i) => {
    for (let c = 0; c < 3; c++) {
      b.writeFloatLE(d.pos[id * 3 + c], i * 32 + c * 4);
      b.writeFloatLE(d.scale[id * 3 + c], i * 32 + 12 + c * 4);
    }
    for (let c = 0; c < 4; c++) b[i * 32 + 24 + c] = d.rgba[id * 4 + c];
    const q = d.rot.subarray(id * 4, id * 4 + 4), length = Math.hypot(...q);
    // .splat stores wxyz in bytes; the classroom stores xyzw as floats.
    [3, 0, 1, 2].forEach((c, j) => { b[i * 32 + 28 + j] = Math.max(0, Math.min(255, Math.round(128 + q[c] / length * 128))); });
  });
  return b;
}

export async function downsampleFile(input, output, count, { force = false } = {}) {
  pointCount(count);
  const sourcePath = await fs.realpath(input), outputPath = path.resolve(output);
  let existingPath = null;
  try { existingPath = await fs.realpath(outputPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (sourcePath.toLowerCase() === outputPath.toLowerCase() || existingPath?.toLowerCase() === sourcePath.toLowerCase()) throw new Error('Output must not overwrite input');
  const inputStat = await fs.stat(input);
  if (existingPath) {
    const outputStat = await fs.stat(existingPath);
    if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) throw new Error('Output must not overwrite input through a hard link');
  }
  if (path.extname(outputPath).toLowerCase() !== '.splat') throw new Error('Output must end in .splat');
  if (inputStat.size > LIMITS.bytes) throw new Error('Input exceeds 512 MiB');
  const b = await fs.readFile(input), d = await decodeFile(b, input);
  const start = performance.now(), indices = selectIndices(d, count), result = encodeSplat(d, indices);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result, { flag: force ? 'w' : 'wx' });
  return { input: sourcePath, output: outputPath, format: d.format, inputPoints: d.n, outputPoints: indices.length,
    inputBytes: b.length, outputBytes: result.length, inputSha256: sha256(b), outputSha256: sha256(result),
    sampling: 'morton-systematic', samplingMs: Math.round(performance.now() - start),
    rotationQuantization: '8-bit normalized wxyz; not lossless', higherSHRemoved: d.sh > 0 };
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('node scripts/splat-downsample.mjs input.spz --points 100000 --output artifacts/workshop-low.splat [--force]');
    return;
  }
  let input, output, points, force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--points') points = Number(args[++i]);
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--force') force = true;
    else if (args[i].startsWith('--') || input) throw new Error(`Unexpected argument: ${args[i]}`);
    else input = args[i];
  }
  if (!input || !output || !points) throw new Error('Provide input, --points, and --output; use --help');
  console.log(JSON.stringify(await downsampleFile(input, output, points, { force }), null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
