import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeFile, decodePly, selectIndices, encodeSplat, validateCloud, downsampleFile } from '../scripts/splat-downsample.mjs';

function cloud(n = 384) {
  const d = { n, pos: new Float32Array(n * 3), scale: new Float32Array(n * 3), rot: new Float32Array(n * 4), rgba: new Uint8Array(n * 4) };
  for (let i = 0; i < n; i++) {
    const sparse = i >= n * 0.875;
    d.pos.set([sparse ? 30 + i / n : Math.sin(i) * 0.3, (i % 12) / 12, Math.cos(i * 0.4) * (sparse ? 2 : 0.1)], i * 3);
    d.scale.set([0.001 + i / n, 0.05, 0.03 + (i % 5) / 100], i * 3);
    const a = i / n * Math.PI;
    d.rot.set([Math.sin(a) / Math.sqrt(2), -Math.sin(a) / Math.sqrt(2), 0, Math.cos(a)], i * 4);
    d.rgba.set([i % 256, (i * 3) % 256, (i * 7) % 256, 32 + i % 224], i * 4);
  }
  return d;
}

test('spatial sampling has exact count and covers separated dense and sparse clusters', () => {
  const d = cloud(), indices = selectIndices(d, 48);
  assert.equal(indices.length, 48);
  assert.equal(new Set(indices).size, 48);
  assert.ok([...indices].some((i) => d.pos[i * 3] > 30));
  assert.ok([...indices].some((i) => d.pos[i * 3] < 1));
  assert.deepEqual(selectIndices(d, 48), indices);
  assert.deepEqual(selectIndices(d, 500), Uint32Array.from({ length: d.n }, (_, i) => i));
});

test('selected Gaussian position, scale and RGBA survive the classroom decoder roundtrip', async () => {
  const d = cloud(), indices = selectIndices(d, 37);
  const decoded = await decodeFile(encodeSplat(d, indices), 'out.splat');
  assert.equal(decoded.n, 37);
  indices.forEach((id, i) => {
    for (let c = 0; c < 3; c++) {
      assert.equal(decoded.pos[i * 3 + c], d.pos[id * 3 + c]);
      assert.equal(decoded.scale[i * 3 + c], d.scale[id * 3 + c]);
    }
    assert.deepEqual([...decoded.rgba.subarray(i * 4, i * 4 + 4)], [...d.rgba.subarray(id * 4, id * 4 + 4)]);
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += decoded.rot[i * 4 + c] * d.rot[id * 4 + c];
    assert.ok(Math.abs(dot) > 0.9998, '8-bit quaternion must preserve rotation to bounded precision');
  });
});

test('rejects non-finite attributes and malformed or unsupported inputs before allocation', async () => {
  for (const invalid of [0, -1, 3.4, Infinity, 10_000_001]) assert.throws(() => selectIndices(cloud(), invalid));
  const d = cloud(); d.pos[0] = NaN; assert.throws(() => validateCloud(d), /position/);
  d.pos[0] = 0; d.scale[0] = 0; assert.throws(() => validateCloud(d), /scale/);
  d.scale[0] = 0.1; d.rot.fill(0, 0, 4); assert.throws(() => validateCloud(d), /quaternion/);
  await assert.rejects(decodeFile(Buffer.alloc(33), 'bad.splat'), /multiple of 32/);
  await assert.rejects(decodeFile(Buffer.alloc(16), 'bad.spz'), /header/);
  const v4 = Buffer.alloc(16); v4.writeUInt32LE(0x5053474e); v4.writeUInt32LE(4, 4); v4.writeUInt32LE(1, 8);
  await assert.rejects(decodeFile(v4, 'v4.spz'), /v2\/v3/);
});

function ply(binary, newline = '\n') {
  const props = ['property float x', 'property float y', 'property float z', 'property ushort red', 'property ushort green', 'property ushort blue',
    'property float scale_0', 'property float scale_1', 'property float scale_2', 'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3'];
  const header = ['ply', `format ${binary ? 'binary_little_endian' : 'ascii'} 1.0`, 'element vertex 2', ...props, 'end_header', ''].join(newline);
  const rows = [[1, 2, 3, 255, 16, 80, -2, -3, -4, 1, 0, 0, 0], [-1, 0.5, 7, 0, 200, 140, -1, -2, -3, 0, 0, 0, 1]];
  if (!binary) return Buffer.from(header + rows.map((r) => r.join(' ')).join(newline));
  const body = Buffer.alloc(2 * 46);
  rows.forEach((row, i) => {
    let at = i * 46;
    row.forEach((v, j) => { if (j >= 3 && j <= 5) { body.writeUInt16LE(v, at); at += 2; } else { body.writeFloatLE(v, at); at += 4; } });
  });
  return Buffer.concat([Buffer.from(header), body]);
}

test('PLY reader handles CRLF, scalar widths, ASCII and normalized quaternions', () => {
  const a = decodePly(ply(false)), b = decodePly(ply(true, '\r\n'));
  assert.deepEqual(a.pos, b.pos);
  assert.deepEqual(a.rgba, b.rgba);
  assert.deepEqual(a.scale, b.scale);
  assert.deepEqual(a.rot, b.rot);
  assert.equal(b.pos[3], -1);
  assert.equal(b.rgba[5], 200);
  assert.deepEqual([...b.rot.slice(4)], [0, 0, 1, 0]);
  assert.throws(() => decodePly(ply(true).subarray(0, ply(true).length - 2)), /Truncated/);
});

// This is a specification fixture, not a real-world v3 validation claim.
function syntheticSpz(version) {
  const raw = Buffer.alloc(16 + (version === 3 ? 20 : 19));
  raw.writeUInt32LE(0x5053474e); raw.writeUInt32LE(version, 4); raw.writeUInt32LE(1, 8); raw[13] = 12;
  raw[17] = 16; // x = 1 in fixed-point 24-bit
  raw[25] = 200; // alpha
  raw.fill(128, 26, 29); raw.fill(128, 29, 32);
  if (version === 3) raw.writeUInt32LE(3 * 2 ** 30, 32); // largest component w, xyz = 0
  else raw.fill(128, 32, 35);
  return gzipSync(raw);
}

test('SPZ v2/v3 encoded headers and rotations decode, without treating fixture as real asset', async () => {
  for (const ver of [2, 3]) {
    const d = await decodeFile(syntheticSpz(ver), 'sample.spz');
    assert.equal(d.n, 1); assert.equal(d.pos[0], 1); assert.equal(d.rgba[3], 200);
    assert.equal(d.format, `SPZ v${ver}`);
    assert.ok(Math.abs(d.rot[3] - 1) < 0.001);
  }
});

test('CLI operation refuses accidental overwrite and produces an exact selected-point file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'life-plaza-splat-'));
  try {
    const input = path.join(dir, 'input.splat'), output = path.join(dir, 'small.splat');
    const d = cloud(); await fs.writeFile(input, encodeSplat(d, selectIndices(d, d.n)));
    await assert.rejects(downsampleFile(input, input, 4, { force: true }), /overwrite input/);
    const hardlink = path.join(dir, 'hardlink.splat');
    await fs.link(input, hardlink);
    await assert.rejects(downsampleFile(input, hardlink, 4, { force: true }), /hard link/);
    const info = await downsampleFile(input, output, 32);
    assert.equal(info.inputPoints, 384); assert.equal(info.outputPoints, 32);
    assert.equal((await fs.stat(output)).size, 1024);
    await assert.rejects(downsampleFile(input, output, 32), { code: 'EEXIST' });
    assert.equal((await downsampleFile(input, output, 32, { force: true })).outputSha256, info.outputSha256);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
