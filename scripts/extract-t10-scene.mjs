// Read JSON literals/base64 as DATA. Never evaluate or copy scripts from the supplied HTML.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), SP = require('../src/splat.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = b => createHash('sha256').update(b).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function literalAt(text, start) {
  let i = start; while (/\s/.test(text[i] || '') && i < text.length) i++;
  const begin = i, opening = text[i];
  if (!['{', '"'].includes(opening)) throw new Error('Expected a strict JSON object or string literal');
  let quoted = opening === '"', escape = false, depth = opening === '{' ? 1 : 0; i++;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (escape) { escape = false; continue; } if (ch === '\\') { escape = true; continue; } if (ch === '"') { quoted = false; if (!depth) return { value: JSON.parse(text.slice(begin, i + 1)), end: i + 1 }; } continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { if (--depth === 0) return { value: JSON.parse(text.slice(begin, i + 1)), end: i + 1 }; }
  }
  throw new Error('Unterminated JSON literal');
}
function oneAssignment(html, re) {
  const found = [...html.matchAll(re)]; if (found.length !== 1) throw new Error(`Expected one ${re.source}, got ${found.length}`);
  const m = found[0], out = literalAt(html, m.index + m[0].length);
  if (!/^\s*;/.test(html.slice(out.end, out.end + 30))) throw new Error('Assignment must end after literal; expressions/concatenation rejected');
  return { ...out, offset: m.index };
}
export function extractEmbedded(html) {
  if (Buffer.byteLength(html) > 32 * 1024 * 1024) throw new Error('HTML exceeds extraction budget');
  const cfg = oneAssignment(html, /window\.CDG_MARBLE\s*=/g), payload = oneAssignment(html, /window\.CDG_MARBLE\.b64\s*=/g);
  for (const k of Object.keys(cfg.value)) if (!['name', 'meta', 'place'].includes(k)) throw new Error('Unknown scene configuration field');
  if (typeof cfg.value.name !== 'string' || !/^[^/\\\x00-\x1f]{1,128}\.spz$/i.test(cfg.value.name)) throw new Error('Expected a basename ending in .spz');
  for (const field of ['meta', 'place']) if (cfg.value[field] != null && (typeof cfg.value[field] !== 'object' || Array.isArray(cfg.value[field]))) throw new Error(`Invalid ${field}`);
  if (typeof payload.value !== 'string' || !payload.value.length || payload.value.length % 4 || /[^A-Za-z0-9+/=]/.test(payload.value)) throw new Error('Invalid base64 data');
  const bytes = Buffer.from(payload.value, 'base64'); if (bytes.toString('base64') !== payload.value) throw new Error('Noncanonical base64 data');
  return { config: cfg.value, bytes, configOffset: cfg.offset, base64Offset: payload.offset };
}

// Minimal bounded ZIP reader: list central directory, decompress only requested entries.
// No paths from an archive are written to disk and no archived source is executed.
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(bytes) { let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ n >>> 8; return (n ^ 0xffffffff) >>> 0; }
function zipEntries(bytes) {
  if (bytes.length > 128 * 1024 * 1024) throw new Error('Archive exceeds limit');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12); let at = bytes.readUInt32LE(end + 16);
  if (count > 10000 || at + size > end || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP directory');
  const out = [];
  for (let k = 0; k < count; k++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const nameLen = bytes.readUInt16LE(at + 28), extraLen = bytes.readUInt16LE(at + 30), commentLen = bytes.readUInt16LE(at + 32);
    if (at + 46 + nameLen + extraLen + commentLen > end) throw new Error('Truncated ZIP entry');
    out.push({ name: bytes.toString('utf8', at + 46, at + 46 + nameLen), flags: bytes.readUInt16LE(at + 8), method: bytes.readUInt16LE(at + 10), crc: bytes.readUInt32LE(at + 16), compressedBytes: bytes.readUInt32LE(at + 20), bytes: bytes.readUInt32LE(at + 24), offset: bytes.readUInt32LE(at + 42) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(zip, e, max = 16 * 1024 * 1024) {
  if (e.flags & 1 || e.bytes > max || e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== 0x04034b50 || ![0, 8].includes(e.method)) throw new Error('Unsupported/oversize ZIP member');
  const at = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
  if (at + e.compressedBytes > zip.length) throw new Error('Truncated ZIP payload');
  const raw = e.method === 0 ? zip.subarray(at, at + e.compressedBytes) : inflateRawSync(zip.subarray(at, at + e.compressedBytes), { maxOutputLength: max });
  if (raw.length !== e.bytes || crc32(raw) !== e.crc) throw new Error('ZIP size/CRC mismatch'); return raw;
}
function inspectArchive(bytes, label, sceneSha, depth = 0) {
  const entries = zipEntries(bytes), report = { archive: label, sha256: sha(bytes), entries: entries.map(e => ({ name: e.name, bytes: e.bytes })), sceneCandidates: [], nested: [] };
  for (const e of entries) {
    if (/\.(spz|ply|splat)$/i.test(e.name)) { const raw = zipRead(bytes, e); report.sceneCandidates.push({ name: e.name, bytes: e.bytes, sha256: sha(raw), matchesExtractedBytes: sha(raw) === sceneSha }); }
    if (/\.html$/i.test(e.name)) {
      const raw = zipRead(bytes, e, 8 * 1024 * 1024), html = raw.toString('utf8'), candidate = { name: e.name, bytes: e.bytes, sha256: sha(raw), hasEmbeddedSceneAssignment: /window\.CDG_MARBLE\s*=/.test(html) };
      if (candidate.hasEmbeddedSceneAssignment) { try { const s = extractEmbedded(html); Object.assign(candidate, { sceneSha256: sha(s.bytes), matchesExtractedBytes: sha(s.bytes) === sceneSha }); } catch (error) { candidate.extractionError = error.message; } }
      report.sceneCandidates.push(candidate);
    }
    if (/\.zip$/i.test(e.name) && depth < 2) report.nested.push(inspectArchive(zipRead(bytes, e), `${label}!${e.name}`, sceneSha, depth + 1));
  }
  return report;
}
function quantiles(a) { a.sort(); const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))]; return { min: a[0], p01: q(.01), p03: q(.03), p05: q(.05), median: q(.5), p95: q(.95), p97: q(.97), p99: q(.99), max: a.at(-1) }; }
function distribution(d) {
  const axes = [0, 1, 2].map(c => quantiles(Float32Array.from({ length: d.n }, (_, i) => d.pos[i * 3 + c]))), scales = [0, 1, 2].map(c => quantiles(Float32Array.from({ length: d.n }, (_, i) => d.scale[i * 3 + c])));
  let qMin = Infinity, qMax = 0, alphaMin = 255, alphaMax = 0, zeroAlpha = 0;
  for (let i = 0; i < d.n; i++) {
    for (let c = 0; c < 3; c++) if (!Number.isFinite(d.pos[i * 3 + c]) || !Number.isFinite(d.scale[i * 3 + c]) || d.scale[i * 3 + c] <= 0) throw new Error('Invalid decoded position/scale');
    const norm = Math.hypot(...d.rot.subarray(i * 4, i * 4 + 4)); if (!Number.isFinite(norm) || norm < 1e-8) throw new Error('Invalid decoded rotation');
    qMin = Math.min(qMin, norm); qMax = Math.max(qMax, norm); const a = d.rgba[i * 4 + 3]; alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a); if (!a) zeroAlpha++;
  }
  return { sourceUnits: 'un-calibrated scene units; no metric scale supplied', positions: Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, axes[i]])), scales: Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, scales[i]])), quaternionLength: { min: qMin, max: qMax }, alpha: { min: alphaMin, max: alphaMax, zeroCount: zeroAlpha }, decodedAttributeSha256: Object.fromEntries(['pos', 'scale', 'rot', 'rgba'].map(k => [k, sha(Buffer.from(d[k].buffer, d[k].byteOffset, d[k].byteLength))])) };
}
function alignment(d, indices) {
  const xs = [], ys = [], zs = [];
  for (const i of indices) { xs.push(d.pos[i * 3]); ys.push(-d.pos[i * 3 + 1] + 1.5); zs.push(-d.pos[i * 3 + 2]); }
  const q = (a, p) => { a.sort((x, y) => x - y); return a[Math.floor(p * a.length)]; };
  const x5 = q(xs, .05), x95 = q(xs, .95), y3 = q(ys, .03), y97 = q(ys, .97), z5 = q(zs, .05), z95 = q(zs, .95);
  const place = { scale: 1, yaw: 0, flip: true, x: 1.2 - (x5 + x95) / 2, y: 1.5 - y3, z: .3 - (z5 + z95) / 2 };
  return { place, sampledPoints: indices.length, roomEstimate: { x0: x5 + place.x, x1: x95 + place.x, z0: z5 + place.z, z1: z95 + place.z, y1: y97 - y3 }, basis: 'Heuristic 5/95% horizontal and 3% vertical source quantiles; not semantic floor detection or metric calibration' };
}
async function sameOrNew(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try { const prior = await fs.readFile(file); if (sha(prior) !== sha(bytes)) throw new Error(`Refusing to replace different existing file: ${file}`); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
}
async function main() {
  const input = path.join(ROOT, 't10.html'), zipPath = path.join(ROOT, '交给技术人员_深化包(1).zip'), out = path.join(ROOT, 'artifacts/new-scene');
  const htmlBytes = await fs.readFile(input), extracted = extractEmbedded(htmlBytes.toString('utf8')), raw = extracted.bytes[0] === 0x1f && extracted.bytes[1] === 0x8b ? gunzipSync(extracted.bytes, { maxOutputLength: 128 * 1024 * 1024 }) : extracted.bytes;
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x5053474e) throw new Error('Embedded file is not SPZ');
  const header = { version: raw.readUInt32LE(4), points: raw.readUInt32LE(8), shDegree: raw[12], fractionalBits: raw[13], flags: raw[14] };
  if (![2, 3].includes(header.version) || header.points < 1 || header.points > 2000000 || header.fractionalBits > 24) throw new Error('Unsupported/budget-exceeding SPZ header');
  const decoded = SP.parseSpz(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), stats = distribution(decoded);
  const oldStep = Math.max(1, Math.floor(decoded.n / 40000)), oldIndices = Uint32Array.from({ length: Math.ceil(decoded.n / oldStep) }, (_, i) => i * oldStep), lod = SP.createLOD(decoded);
  const currentAlignment = alignment(decoded, lod.order.subarray(0, Math.min(decoded.n, 40000))), originalAlignment = alignment(decoded, oldIndices);
  const sceneSha = sha(extracted.bytes), archive = inspectArchive(await fs.readFile(zipPath), path.basename(zipPath), sceneSha);
  const manifest = { source: { file: 't10.html', sha256: sha(htmlBytes), bytes: htmlBytes.length, extraction: 'Strict JSON + canonical base64 parsing only; no supplied JavaScript executed' },
    asset: { file: 'assets/scenes/t10-world-low.spz', originalName: extracted.config.name, sha256: sceneSha, bytes: extracted.bytes.length, rawBytes: raw.length, ...header },
    embeddedMetadata: extracted.config.meta ?? null, embeddedPlacement: extracted.config.place ?? null,
    provenanceLimit: 'User-provided embedded scene. Its filename/header does not establish that it is an automotive workshop. Visual inspection and provenance review required.',
    stats, alignment: { originalHtmlDefault: { scale: 1, yaw: 0, flip: true, x: 0, y: 1.5, z: 0 }, originalAutoAlignApproximation: originalAlignment, currentRendererAutoAlign: currentAlignment,
      caution: 't10 stored no PLACE or metricScale. Browser localStorage overrides cannot be recovered from this HTML. Suggestions are not user-approved saved coordinates.' } };
  await sameOrNew(path.join(ROOT, manifest.asset.file), extracted.bytes);
  await sameOrNew(path.join(ROOT, 'assets/scenes/t10-world-low.scene.json'), json(manifest));
  await sameOrNew(path.join(out, 'extraction.json'), json({ ...manifest, archiveComparison: archive }));
  await sameOrNew(path.join(ROOT, '.local/handoff-20261109/scene-extracted.spz'), extracted.bytes);
  await sameOrNew(path.join(ROOT, '.local/handoff-20261109/scene-placement-candidate.json'), json(currentAlignment.place));
  // Only trusted current workspace renderer sources go into this independent viewer.
  const engine = await fs.readFile(path.join(ROOT, 'src/engine.js'), 'utf8'), splat = await fs.readFile(path.join(ROOT, 'src/splat.js'), 'utf8');
  const cfg = JSON.stringify({ b64: extracted.bytes.toString('base64'), place: currentAlignment.place, room: currentAlignment.roomEstimate, header, sha256: sceneSha }).replace(/</g, '\\u003c');
  const boot = `const info=${cfg};const canvas=document.querySelector('canvas'),R=new E.Renderer(canvas),C=new E.Camera(),scene=new E.Node(),world=new CDG_SPLAT.SplatWorld(R.gl,{pointBudget:100000});R.env.clear=E.hex('#e9e4da');R.splat=world;window.preview={info,R,C,world};const raw=Uint8Array.from(atob(info.b64),c=>c.charCodeAt(0)).buffer;world.load(raw,'t10-world-low.spz').then(()=>{world.setPlacement(info.place);document.querySelector('#status').textContent='SPZ v'+info.header.version+' · '+world.src.n+' source / '+world.n+' active · source hash '+info.sha256.slice(0,12);look('inside');requestAnimationFrame(frame);}).catch(e=>document.querySelector('#status').textContent='ERROR '+e.message);function look(view){C.target=[1.2,1.6,.3];C.pitch=0;C.dist=.2;C.yaw=({inside:0,back:Math.PI,left:Math.PI/2,right:-Math.PI/2})[view]??0;if(view==='overview'){C.target=[1.2,1.6,.3];C.dist=Math.max(info.room.x1-info.room.x0,info.room.z1-info.room.z0)*1.05;C.pitch=.6;C.yaw=.6;}}document.querySelectorAll('button').forEach(b=>b.onclick=()=>look(b.dataset.view));E.orbitControls(canvas,C);function frame(){R.render(scene,C);document.querySelector('#gl').textContent='GL '+R.gl.getError()+' · camera '+JSON.stringify({target:C.target,yaw:C.yaw,pitch:C.pitch,dist:C.dist});requestAnimationFrame(frame);}`;
  const viewer = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><title>t10 独立场景核验（未执行原HTML脚本）</title><style>body{margin:0;background:#e9e4da;font:14px system-ui}canvas{width:100vw;height:100vh;display:block}header{position:fixed;left:12px;top:12px;background:#fffdf3e8;padding:12px;max-width:85vw;border-radius:8px}button{margin:8px 4px 0 0;padding:8px}small{display:block}</style><canvas></canvas><header><b>仅核验 t10 点云；不是已通过验收的车间</b><div id="status">loading</div><small id="gl"></small><button data-view="inside">正面</button><button data-view="back">背面</button><button data-view="left">左侧</button><button data-view="right">右侧</button><button data-view="overview">外观总览</button></header><script>${(engine+'\n'+splat+'\n'+boot).replace(/<\/script/gi,'<\\/script')}</script></html>`;
  await sameOrNew(path.join(out, 'viewer.html'), viewer);
  console.log(json({ asset: manifest.asset, embeddedMetadata: manifest.embeddedMetadata, embeddedPlacement: manifest.embeddedPlacement, currentAlignment, sourceAttributeChecks: 'finite positions, positive finite scales, nonzero finite quaternions', report: 'artifacts/new-scene/extraction.json', viewer: 'artifacts/new-scene/viewer.html', archiveSceneCandidates: archive.sceneCandidates, nestedCandidates: archive.nested.map(n => n.sceneCandidates) }));
}
if (process.argv.includes('--self-test')) {
  const b = Buffer.from('not executed'), canonical = b.toString('base64');
  const good = `window.CDG_MARBLE={"name":"test.spz","meta":null,"place":null};window.CDG_MARBLE.b64=${JSON.stringify(canonical)};throw new Error('must never run');`;
  if (sha(extractEmbedded(good).bytes) !== sha(b)) throw new Error('Extraction mismatch');
  for (const bad of [good.replace('null', '(()=>{throw 1})()'),good.replace(JSON.stringify(canonical), `${JSON.stringify(canonical)}+"x"`),good+good]) { let rejected = false; try { extractEmbedded(bad); } catch { rejected = true; } if (!rejected) throw new Error('Unsafe literal accepted'); }
  console.log('Static extraction self-test passed; executable expressions and duplicate assignments rejected.');
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
