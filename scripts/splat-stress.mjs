// Synthetic stress harness. This never downloads assets or claims to represent a Marble workshop.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url), ROOT = path.resolve(path.dirname(SELF), '..');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'splat-stress');
const CLI = path.join(ROOT, 'scripts', 'splat-downsample.mjs');
const OFFICIAL_SHA = '238f0a666478d64f2610246e01d2d0bab80f74e74c2a41e037be207440a06872';
const MiB = 1024 ** 2, clockStart = performance.now();
const bytesHash = b => createHash('sha256').update(b).digest('hex');
const inside = p => { const full = path.resolve(p), rel = path.relative(ARTIFACT_ROOT, full); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Output must be strictly inside artifacts/splat-stress'); return full; };
const integer = (n, min, max, label) => { if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`); return n; };
async function fileHash(p) { const h = createHash('sha256'); for await (const chunk of createReadStream(p)) h.update(chunk); return h.digest('hex'); }
async function json(p, x) { await fs.writeFile(p, JSON.stringify(x, null, 2) + '\n'); }

// Loaded with --import before the ACTUAL unmodified downsample CLI. Even its failure exit records RSS.
if (process.env.SPLAT_STRESS_METRICS) {
  const output = inside(process.env.SPLAT_STRESS_METRICS);
  process.on('exit', exitCode => {
    const usage = process.resourceUsage();
    try { writeFileSync(output, JSON.stringify({ exitCode, elapsedMs: performance.now() - clockStart, maxRSS: usage.maxRSS,
      maxRSSUnit: 'KiB (1024 bytes), process.resourceUsage().maxRSS', maxRSSMiB: usage.maxRSS / 1024,
      userCPUTimeUs: usage.userCPUTime, systemCPUTimeUs: usage.systemCPUTime, finalMemoryUsageBytes: process.memoryUsage() }, null, 2) + '\n'); }
    catch (error) { console.error(`Unable to write stress metrics: ${error.message}`); }
  });
}

// A bijective lattice with a dense 1.5m-point box and a separated, spatially larger 0.5m-point box.
// Binary fractions make position quantization exact in SPZ fractionalBits=12.
function sample(i, p) {
  const x = i % 125, y = Math.floor(i / 125) % 125, z = Math.floor(i / 15625), sparse = z >= 96;
  p[0] = sparse ? 64 + (x - 62) / 2 : (x - 62) / 8;
  p[1] = (y - 62) / (sparse ? 4 : 16);
  p[2] = sparse ? 32 + (z - 96) / 2 : (z - 48) / 8;
  for (let c = 0; c < 3; c++) p[3 + c] = -6 + ((i * (c * 2 + 1) + c * 11) % 64) / 16;
  const half = ((i * 17) % 720) / 720 * Math.PI, s = Math.sin(half) / Math.sqrt(14);
  p[6] = s; p[7] = s * 2; p[8] = s * 3; p[9] = Math.cos(half);
  p[10] = (i * 37 + 17) % 256; p[11] = (i * 73 + 91) % 256; p[12] = (i * 19 + 223) % 256; p[13] = 32 + (i * 13) % 223;
}
function sourceId(x, y, z) {
  const sparse = z >= 10;
  const ix = Math.round((sparse ? x - 64 : x) * (sparse ? 2 : 8) + 62);
  const iy = Math.round(y * (sparse ? 4 : 16) + 62);
  const iz = Math.round(sparse ? (z - 32) * 2 + 96 : z * 8 + 48);
  if (ix < 0 || ix >= 125 || iy < 0 || iy >= 125 || iz < 0 || iz >= 128) return -1;
  return ix + iy * 125 + iz * 15625;
}
function plyHeader(n) {
  return Buffer.from(['ply', 'format binary_little_endian 1.0', 'comment SYNTHETIC stress fixture, not a Marble export', `element vertex ${n}`,
    ...['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map(p => `property float ${p}`),
    ...['red', 'green', 'blue', 'alpha'].map(p => `property uchar ${p}`), 'end_header', ''].join('\n'));
}
async function generatePly(job) {
  const fd = await fs.open(job.output, 'wx'), header = plyHeader(job.points), chunkPoints = 16384, chunk = Buffer.alloc(chunkPoints * 44), p = new Float64Array(14);
  try {
    await fd.write(header);
    for (let base = 0; base < job.points; base += chunkPoints) {
      const count = Math.min(chunkPoints, job.points - base);
      for (let j = 0; j < count; j++) {
        sample(base + j, p); const off = j * 44;
        for (let c = 0; c < 6; c++) chunk.writeFloatLE(p[c], off + c * 4);
        for (const [k, source] of [9, 6, 7, 8].entries()) chunk.writeFloatLE(p[source], off + 24 + k * 4);
        for (let c = 0; c < 4; c++) chunk[off + 40 + c] = p[10 + c];
      }
      await fd.write(chunk.subarray(0, count * 44));
    }
  } finally { await fd.close(); }
  return { synthetic: true, format: 'binary_little_endian PLY', pointCount: job.points, vertexStride: 44, headerBytes: header.length,
    bytes: (await fs.stat(job.output)).size, sha256: await fileHash(job.output) };
}
async function generateSpz(job) {
  const moduleHash = await fileHash(job.module);
  if (moduleHash !== OFFICIAL_SHA) throw new Error('Official module hash mismatch; this harness does not execute an unpinned module');
  const { default: init } = await import(pathToFileURL(job.module).href), official = await init();
  const n = job.points, p = new Float64Array(14), cloud = { numPoints: n, shDegree: 0, antialiased: false, extensions: [],
    positions: new Float32Array(n * 3), scales: new Float32Array(n * 3), rotations: new Float32Array(n * 4),
    alphas: new Float32Array(n), colors: new Float32Array(n * 3), sh: new Float32Array(0) };
  for (let i = 0; i < n; i++) {
    sample(i, p);
    for (let c = 0; c < 3; c++) { cloud.positions[i * 3 + c] = p[c]; cloud.scales[i * 3 + c] = p[3 + c]; cloud.colors[i * 3 + c] = (p[10 + c] / 255 - .5) / 0.28209479177387814; }
    for (let c = 0; c < 4; c++) cloud.rotations[i * 4 + c] = p[6 + c];
    cloud.alphas[i] = Math.log(p[13] / (255 - p[13]));
  }
  const encoded = Buffer.from(official.saveSpzToBuffer(cloud, { version: 3, from: official.CoordinateSystem.UNSPECIFIED, sh1Bits: 5, shRestBits: 4 }));
  await fs.writeFile(job.output, encoded, { flag: 'wx' });
  const raw = gunzipSync(encoded, { maxOutputLength: 128 * MiB });
  if (raw.readUInt32LE(4) !== 3 || raw.readUInt32LE(8) !== n) throw new Error('Official encoder count/version mismatch');
  return { synthetic: true, format: 'SPZ v3', pointCount: n, shDegree: raw[12], fractionalBits: raw[13],
    bytes: encoded.length, decompressedBytes: raw.length, sha256: bytesHash(encoded), moduleSha256: moduleHash,
    origin: 'Synthetic analytic point cloud encoded locally with existing official Niantic WASM; NOT a real Marble export' };
}
async function verifyOutput(job) {
  const out = await fs.readFile(job.output), cli = JSON.parse(await fs.readFile(job.cliLog, 'utf8'));
  if (out.length !== job.target * 32) throw new Error('Incorrect output point count/byte length');
  const firstHash = bytesHash(out), repeatHash = await fileHash(job.repeat), inputHash = await fileHash(job.input);
  if (firstHash !== repeatHash || cli.inputSha256 !== inputHash || cli.outputSha256 !== firstHash || cli.inputPoints !== job.points || cli.outputPoints !== job.target) throw new Error('CLI metadata/hash/repeat mismatch');
  const p = new Float64Array(14), seen = new Uint8Array(job.points), bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let maxPositionError = 0, maxScaleRelativeError = 0, maxColorByteError = 0, maxAlphaByteError = 0, maxRotationRadians = 0, sparsePoints = 0;
  // Independent .splat binary reader and analytic oracle: no import of the sampler or its encoder.
  for (let i = 0; i < job.target; i++) {
    const off = i * 32, xyz = [0, 1, 2].map(c => out.readFloatLE(off + c * 4)), id = sourceId(...xyz);
    if (id < 0 || id >= job.points || seen[id]) throw new Error(`Invalid/duplicate source point at ${i}`);
    seen[id] = 1; sample(id, p); if (id >= 1500000) sparsePoints++;
    for (let c = 0; c < 3; c++) {
      const scale = out.readFloatLE(off + 12 + c * 4), expected = Math.fround(Math.exp(p[3 + c]));
      if (!Number.isFinite(xyz[c]) || !Number.isFinite(scale) || scale <= 0) throw new Error('Non-finite/invalid output attributes');
      maxPositionError = Math.max(maxPositionError, Math.abs(xyz[c] - p[c]));
      maxScaleRelativeError = Math.max(maxScaleRelativeError, Math.abs(scale - expected) / expected);
      maxColorByteError = Math.max(maxColorByteError, Math.abs(out[off + 24 + c] - p[10 + c]));
      bounds.min[c] = Math.min(bounds.min[c], xyz[c]); bounds.max[c] = Math.max(bounds.max[c], xyz[c]);
    }
    maxAlphaByteError = Math.max(maxAlphaByteError, Math.abs(out[off + 27] - p[13]));
    const q = [out[off + 29], out[off + 30], out[off + 31], out[off + 28]].map(x => (x - 128) / 128), len = Math.hypot(...q);
    if (!Number.isFinite(len) || len < 1e-8) throw new Error('Invalid output quaternion');
    const dot = Math.abs(q.reduce((s, v, c) => s + v / len * p[6 + c], 0));
    maxRotationRadians = Math.max(maxRotationRadians, 2 * Math.acos(Math.min(1, dot)));
  }
  const tolerances = { position: 0, scaleRelative: 1e-6, colorBytes: job.format === 'ply' ? 0 : 2, alphaBytes: job.format === 'ply' ? 0 : 1, rotationRadians: Math.PI / 60 };
  if (maxPositionError !== 0 || maxScaleRelativeError > tolerances.scaleRelative || maxColorByteError > tolerances.colorBytes || maxAlphaByteError > tolerances.alphaBytes || maxRotationRadians > tolerances.rotationRadians) throw new Error(`Attribute mismatch: ${JSON.stringify({ maxPositionError, maxScaleRelativeError, maxColorByteError, maxAlphaByteError, maxRotationRadians })}`);
  if (job.points > 1500000 && (!sparsePoints || sparsePoints === job.target)) throw new Error('Dense/sparse cluster coverage failed');
  return { result: 'pass', synthetic: true, pointCount: job.target, uniqueSourcePoints: job.target, outputBytes: out.length,
    inputSha256: inputHash, outputSha256: firstHash, repeatSha256: repeatHash, deterministicRepeat: true, bounds,
    densePoints: job.target - sparsePoints, sparsePoints, maxPositionError, maxScaleRelativeError, maxColorByteError, maxAlphaByteError,
    maxRotationRadians, maxRotationDegrees: maxRotationRadians * 180 / Math.PI, tolerances,
    oracle: 'Independent binary .splat reader; inverse analytic coordinates identify original point, then check every output attribute' };
}
async function boundaries(job) {
  const ply = path.join(job.dir, 'truncated-synthetic.ply'); await fs.writeFile(ply, Buffer.concat([plyHeader(job.points), Buffer.alloc(44)]));
  const raw = Buffer.alloc(16); raw.writeUInt32LE(0x5053474e, 0); raw.writeUInt32LE(3, 4); raw.writeUInt32LE(job.points, 8); raw[13] = 12;
  const spz = path.join(job.dir, 'truncated-synthetic.spz'); await fs.writeFile(spz, gzipSync(raw, { mtime: 0 }));
  const oversized = path.join(job.dir, 'oversized-temporary.ply'); const fd = await fs.open(oversized, 'wx'); try { await fd.truncate(512 * MiB + 1); } finally { await fd.close(); }
  return { ply, spz, oversized, oversizedBytes: 512 * MiB + 1 };
}
async function worker(jobFile) {
  const job = JSON.parse(await fs.readFile(inside(jobFile), 'utf8'));
  let result;
  if (job.kind === 'generate-ply') result = await generatePly(job);
  else if (job.kind === 'generate-spz') result = await generateSpz(job);
  else if (job.kind === 'verify') result = await verifyOutput(job);
  else if (job.kind === 'boundaries') result = await boundaries(job);
  else throw new Error('Unknown stress worker');
  await json(inside(job.result), result);
}

async function main(args) {
  if (args.includes('--help')) { console.log('node scripts/splat-stress.mjs [--out artifacts/splat-stress/NEW-DIR] [--points 2000000] [--target 100000] [--official-module .local/spz-official/spz.mjs] [--timeout-ms 300000] [--min-free-mib 2048]'); return; }
  const opts = { points: 2000000, target: 100000, 'official-module': path.join(ROOT, '.local/spz-official/spz.mjs'), 'timeout-ms': 300000, 'min-free-mib': 2048 };
  for (let i = 0; i < args.length; i += 2) { const key = args[i].replace(/^--/, ''); if (!['out', ...Object.keys(opts)].includes(key) || !args[i + 1]) throw new Error('Unknown/missing argument; use --help'); opts[key] = ['points', 'target', 'timeout-ms', 'min-free-mib'].includes(key) ? Number(args[i + 1]) : args[i + 1]; }
  integer(opts.points, 1, 2000000, 'points'); integer(opts.target, 1, opts.points, 'target'); integer(opts['timeout-ms'], 1000, 600000, 'timeout-ms'); integer(opts['min-free-mib'], 512, 65536, 'min-free-mib');
  const out = inside(opts.out || path.join(ARTIFACT_ROOT, new Date().toISOString().replace(/[:.]/g, '-'))), modulePath = path.resolve(opts['official-module']);
  await fs.mkdir(ARTIFACT_ROOT, { recursive: true }); await fs.mkdir(out); // Never silently replace an earlier run.
  const report = { synthetic: true, generator: 'two-density-lattice-v1', createdAt: new Date().toISOString(), points: opts.points, target: opts.target,
    provenance: 'Analytic synthetic stress input; not user workshop data, not a Marble export, no network or paid calls',
    node: process.version, platform: process.platform, architecture: process.arch, cpuModel: os.cpus()[0]?.model, logicalCPUs: os.cpus().length,
    totalMemoryBytes: os.totalmem(), initialFreeMemoryBytes: os.freemem(), rssUnit: 'KiB (1024 bytes); process.resourceUsage().maxRSS',
    rssDocumentation: 'https://nodejs.org/api/process.html#processresourceusage',
    measurement: 'Every generation, actual CLI invocation, and verification uses a separate serial Node child. CLI measured via --import exit hook. maxRSS is whole child high-water RSS, not incremental heap; parent wall includes startup.',
    isolation: { heapLimitMiB: 768, hardRssLimit: null, minFreeMemoryMiB: opts['min-free-mib'], timeoutMs: opts['timeout-ms'], note: 'V8 heap cap does NOT cap typed arrays/WASM or OS RSS. Free-memory preflight and serial bounded inputs reduce, but do not eliminate, host OOM risk.' },
    codeHashes: { stress: await fileHash(SELF), downsample: await fileHash(CLI), decoder: await fileHash(path.join(ROOT, 'src/splat.js')) }, stages: [], cases: [], boundaries: [], result: 'running' };
  const save = () => json(path.join(out, 'report.json'), report);
  await save();
  async function run(id, command, expectedExit = 0) {
    const log = path.join(out, id + '.stdout.log'), err = path.join(out, id + '.stderr.log'), metrics = path.join(out, id + '.metrics.json');
    const entry = { id, command: [process.execPath, ...command], stdout: log, stderr: err, metricsFile: metrics, expectedExit, freeMemoryBeforeBytes: os.freemem() }; report.stages.push(entry);
    if (entry.freeMemoryBeforeBytes < opts['min-free-mib'] * MiB) { entry.status = 'blocked-low-memory'; await save(); throw new Error(`Free memory below ${opts['min-free-mib']} MiB before ${id}`); }
    console.log(`Starting ${id}`); const started = performance.now(), stdout = createWriteStream(log), stderr = createWriteStream(err);
    let timeout = false, spawnError;
    const child = spawn(process.execPath, command, { cwd: ROOT, windowsHide: true, env: { ...process.env, SPLAT_STRESS_METRICS: metrics }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, opts['timeout-ms']);
    child.on('error', error => { spawnError = error.message; });
    const [code, signal] = await once(child, 'close'); clearTimeout(timer);
    await Promise.all([stdout.closed ? Promise.resolve() : once(stdout, 'close'), stderr.closed ? Promise.resolve() : once(stderr, 'close')]);
    entry.wallMs = performance.now() - started; entry.exitCode = code; entry.signal = signal; entry.timeout = timeout;
    try { entry.resourceUsage = JSON.parse(await fs.readFile(metrics, 'utf8')); } catch { entry.resourceUsage = null; }
    entry.status = !timeout && !spawnError && (expectedExit === 0 ? code === 0 : Number.isInteger(code) && code !== 0) ? 'pass' : 'fail';
    if (spawnError) entry.error = spawnError;
    if (entry.status !== 'pass') entry.stderrTail = (await fs.readFile(err, 'utf8')).slice(-4000);
    await save(); console.log(`${entry.status} ${id}: ${entry.wallMs.toFixed(1)} ms; peak RSS ${entry.resourceUsage?.maxRSSMiB?.toFixed(1) ?? 'unavailable'} MiB`);
    if (entry.status !== 'pass') throw new Error(`${id} failed; inspect report/logs`);
    return entry;
  }
  async function work(id, payload) {
    const job = path.join(out, id + '.job.json'), result = path.join(out, id + '.result.json'); await json(job, { ...payload, result });
    const stage = await run(id, ['--max-old-space-size=768', SELF, '--worker', job]);
    return { stage, result: JSON.parse(await fs.readFile(result, 'utf8')) };
  }
  const cli = (input, output, count) => ['--max-old-space-size=768', '--import', pathToFileURL(SELF).href, CLI, input, '--points', String(count), '--output', output];
  try {
    for (const format of ['ply', 'spz-v3']) {
      const input = path.join(out, `synthetic-${format}-${opts.points}.${format === 'ply' ? 'ply' : 'spz'}`), output = path.join(out, `synthetic-${format}-${opts.target}.splat`), repeat = path.join(out, `synthetic-${format}-${opts.target}-repeat.splat`);
      const generated = await work('generate-' + format, { kind: format === 'ply' ? 'generate-ply' : 'generate-spz', points: opts.points, module: modulePath, output: input });
      const first = await run('cli-' + format, cli(input, output, opts.target));
      const second = await run('cli-' + format + '-repeat', cli(input, repeat, opts.target));
      const verified = await work('verify-' + format, { kind: 'verify', format, points: opts.points, target: opts.target, input, output, repeat, cliLog: first.stdout });
      report.cases.push({ format, input, output, repeat, generated: generated.result, firstCli: first.id, repeatCli: second.id, verification: verified.result }); await save();
    }
    const fixtures = await work('make-boundaries', { kind: 'boundaries', dir: out, points: opts.points });
    const boundaryCases = [ ['zero-count', report.cases[0].input, 0], ['above-point-limit', report.cases[0].input, 10000001], ['truncated-ply', fixtures.result.ply, opts.target], ['truncated-spz', fixtures.result.spz, opts.target], ['above-byte-limit', fixtures.result.oversized, opts.target] ];
    for (const [id, input, count] of boundaryCases) {
      const output = path.join(out, 'MUST-NOT-EXIST-' + id + '.splat'), stage = await run('boundary-' + id, cli(input, output, count), 1);
      let exists = false; try { await fs.stat(output); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (exists) throw new Error(`Rejected boundary unexpectedly wrote ${output}`);
      report.boundaries.push({ id, result: 'rejected-without-output', exitCode: stage.exitCode, message: (await fs.readFile(stage.stderr, 'utf8')).trim(), maxRSSKiB: stage.resourceUsage?.maxRSS ?? null }); await save();
    }
    // Delete only this exact freshly-created oversized placeholder, never a directory or user input.
    await fs.unlink(inside(fixtures.result.oversized)); report.oversizedPlaceholderRemoved = true;
    report.result = 'pass';
  } catch (error) { report.result = 'fail'; report.error = error.message; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.parentMaxRSSKiB = process.resourceUsage().maxRSS; await save();
  console.log(JSON.stringify({ result: report.result, report: path.join(out, 'report.json'), outputs: report.cases.map(c => c.output), parentMaxRSSKiB: report.parentMaxRSSKiB }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === '--worker') await worker(process.argv[3]).catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
  else await main(process.argv.slice(2)).catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
