// Explicit interoperability test; never called by offline unit tests.
// Supply a downloaded official Niantic WASM module, not an arbitrary script.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decodeFile, encodeSplat, selectIndices } from './splat-downsample.mjs';

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--module', '--input', '--out'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Use --module official-spz.mjs --input scene.spz --out artifacts/result-directory');
  opts[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!opts.module || !opts.input || !opts.out) throw new Error('Use --module official-spz.mjs --input scene.spz --out artifacts/result-directory');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const moduleBytes = await fs.readFile(opts.module), input = await fs.readFile(opts.input);
const { default: init } = await import(pathToFileURL(path.resolve(opts.module)).href);
const official = await init();
const load = (b) => official.loadSpzFromBuffer(new Uint8Array(b), { to: official.CoordinateSystem.UNSPECIFIED });
const original = load(input);
const encoded = Buffer.from(official.saveSpzToBuffer(original, {
  version: 3, from: official.CoordinateSystem.UNSPECIFIED, sh1Bits: 5, shRestBits: 4,
}));
const version = gunzipSync(encoded).readUInt32LE(4);
if (version !== 3) throw new Error(`Official encoder produced format version ${version}, expected 3`);
const reference = load(encoded), actual = await decodeFile(encoded, 'official-v3.spz');
if (actual.n !== reference.numPoints || !actual.n) throw new Error('Point count mismatch');
let maxPositionError = 0, maxScaleRelativeError = 0, maxRotationError = 0, maxColorByteError = 0;
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
for (let i = 0; i < actual.n; i++) {
  for (let c = 0; c < 3; c++) {
    const id = i * 3 + c, scale = Math.exp(reference.scales[id]);
    maxPositionError = Math.max(maxPositionError, Math.abs(actual.pos[id] - reference.positions[id]));
    maxScaleRelativeError = Math.max(maxScaleRelativeError, Math.abs(actual.scale[id] - scale) / scale);
    const color = byte((0.5 + 0.28209479177387814 * reference.colors[id]) * 255);
    maxColorByteError = Math.max(maxColorByteError, Math.abs(actual.rgba[i * 4 + c] - color));
  }
  const alpha = byte(255 / (1 + Math.exp(-reference.alphas[i])));
  maxColorByteError = Math.max(maxColorByteError, Math.abs(actual.rgba[i * 4 + 3] - alpha));
  for (let c = 0; c < 4; c++) maxRotationError = Math.max(maxRotationError, Math.abs(actual.rot[i * 4 + c] - reference.rotations[i * 4 + c]));
}
if (maxPositionError > 1e-6 || maxScaleRelativeError > 1e-6 || maxRotationError > 1e-6 || maxColorByteError > 1) throw new Error(JSON.stringify({ maxPositionError, maxScaleRelativeError, maxRotationError, maxColorByteError }));
await fs.mkdir(opts.out, { recursive: true });
await fs.writeFile(path.join(opts.out, 'official-v3.spz'), encoded);
const sampled = encodeSplat(actual, selectIndices(actual, Math.min(actual.n, 100000)));
const roundtrip = await decodeFile(sampled, 'sampled.splat');
await fs.writeFile(path.join(opts.out, 'official-v3-100k.splat'), sampled);
const report = {
  officialModule: 'https://nianticlabs.github.io/spz/spz.js', officialModuleSha256: sha256(moduleBytes),
  input: path.resolve(opts.input), inputSha256: sha256(input),
  convertedFormat: version, convertedSha256: sha256(encoded), convertedBytes: encoded.length,
  pointsCompared: actual.n, maxPositionError, maxScaleRelativeError, maxRotationError, maxColorByteError,
  roundtripPoints: roundtrip.n, result: 'pass',
  scope: 'Real scene re-encoded with official Niantic encoder into v3 and compared with official decoder; not a native workshop export or a browser rendering test.',
};
await fs.writeFile(path.join(opts.out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
