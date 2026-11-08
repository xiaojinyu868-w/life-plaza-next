// Technical texture-budget adaptation, without geometry edits or image generation.
// Usage: node prepare-character.cjs SOURCE.glb [model.runtime.glb] [MAX_EDGE<=2048]
// Run with the bundled runtime's node/bin/node.exe; sharp resolves beside that runtime.
// Originals are read-only. Only runtime GLB/report and this invocation's temporary files are written.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const MAX_BYTES = 128 * 1024 * 1024, MAX_PIXELS = 32 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const align4 = n => Math.ceil(n / 4) * 4;

function parseGLB(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 20 && bytes.length <= MAX_BYTES, 'Invalid GLB size');
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'Only GLB 2 is supported');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length mismatch');
  const chunks = []; let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated chunk header');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
    assert.ok(length % 4 === 0 && offset + length <= bytes.length, 'Invalid chunk range');
    if (!chunks.length) assert.equal(type, 0x4e4f534a, 'JSON must be the first chunk');
    const data = bytes.subarray(offset, offset + length);
    if (type === 0x4e4f534a) { assert.equal(json, undefined, 'Duplicate JSON'); json = JSON.parse(data.toString('utf8')); }
    else if (type === 0x004e4942) { assert.equal(binary, undefined, 'Duplicate BIN'); binary = data; }
    chunks.push({ type, data }); offset += length;
  }
  assert.equal(json?.asset?.version, '2.0');
  assert.ok(binary && json.buffers?.length === 1 && json.buffers[0].uri === undefined, 'One embedded buffer is required');
  assert.ok(Number.isSafeInteger(json.buffers[0].byteLength) && json.buffers[0].byteLength > 0 && binary.length - json.buffers[0].byteLength >= 0 && binary.length - json.buffers[0].byteLength <= 3, 'Invalid embedded buffer length');
  assert.ok(Array.isArray(json.bufferViews) && json.bufferViews.length <= 10000, 'Invalid bufferViews');
  assert.ok(Array.isArray(json.images) && json.images.length <= 100, 'Expected embedded image records');
  return { json, binary, chunks };
}
function viewBytes(parsed, id) {
  assert.ok(Number.isSafeInteger(id) && id >= 0 && id < parsed.json.bufferViews.length, 'Invalid bufferView reference');
  const view = parsed.json.bufferViews[id], start = view.byteOffset ?? 0;
  assert.ok(view.buffer === 0 && Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(view.byteLength) && view.byteLength > 0 && start + view.byteLength <= parsed.json.buffers[0].byteLength, 'Invalid bufferView bounds');
  return parsed.binary.subarray(start, start + view.byteLength);
}
function packageGLB(parsed, json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const chunks = parsed.chunks.map(chunk => {
    const replacement = chunk.type === 0x4e4f534a ? jsonBytes : chunk.type === 0x004e4942 ? binary : chunk.data;
    const data = Buffer.alloc(align4(replacement.length), chunk.type === 0x4e4f534a ? 32 : 0); replacement.copy(data);
    const header = Buffer.alloc(8); header.writeUInt32LE(data.length); header.writeUInt32LE(chunk.type, 4);
    return Buffer.concat([header, data]);
  });
  const total = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.ok(total <= 64 * 1024 * 1024, 'Runtime GLB exceeds the classroom build limit');
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  return Buffer.concat([header, ...chunks]);
}
function verify(original, runtime, imageViews) {
  const projection = parsed => {
    const copy = structuredClone(parsed.json); delete copy.buffers[0].byteLength;
    copy.bufferViews.forEach((view, i) => { delete view.byteOffset; if (imageViews.has(i)) delete view.byteLength; });
    return copy;
  };
  assert.deepEqual(projection(runtime), projection(original), 'Only buffer offsets/lengths may change in glTF JSON');
  const preservedViews = [];
  for (let i = 0; i < original.json.bufferViews.length; i++) if (!imageViews.has(i)) {
    const before = viewBytes(original, i), after = viewBytes(runtime, i);
    assert.ok(before.equals(after), 'Non-image bytes changed in bufferView ' + i);
    preservedViews.push({ bufferView: i, bytes: before.length, beforeSha256: hash(before), afterSha256: hash(after) });
  }
  const unknown = parsed => parsed.chunks.filter(c => ![0x4e4f534a, 0x004e4942].includes(c.type));
  assert.equal(unknown(original).length, unknown(runtime).length);
  unknown(original).forEach((chunk, i) => { assert.equal(chunk.type, unknown(runtime)[i].type); assert.ok(chunk.data.equals(unknown(runtime)[i].data)); });
  return { gltfFieldsPreserved: true, accessorsUnchanged: true, meshesUnchanged: true, materialsUnchanged: true,
    imageAndTextureReferencesUnchanged: true, nonImageBufferViewsByteIdentical: true, unknownChunksByteIdentical: true, preservedViews };
}
function loadSharp() {
  try { return require('sharp'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require(path.resolve(path.dirname(process.execPath), '../node_modules/sharp'));
  }
}
async function prepare(input, output, maxEdge = 2048) {
  input = path.resolve(input); output = path.resolve(output || path.join(path.dirname(input), 'model.runtime.glb'));
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.notEqual(comparable(input), comparable(output), 'The original must never be overwritten');
  assert.equal(comparable(path.dirname(output)), comparable(path.dirname(input)), 'Runtime output must stay beside the explicitly named source');
  assert.equal(path.basename(output), 'model.runtime.glb', 'Only the runtime output filename may be written');
  assert.ok(Number.isSafeInteger(maxEdge) && maxEdge >= 1 && maxEdge <= 2048, 'MAX_EDGE must be 1–2048');
  const reportPath = path.join(path.dirname(output), 'model.runtime.optimization.json');
  const originalBytes = fs.readFileSync(input), originalHash = hash(originalBytes), original = parseGLB(originalBytes), json = structuredClone(original.json);
  const sharp = loadSharp(), replacements = new Map(), imageViews = new Set(), images = [];
  const geometryViews = new Set((json.accessors || []).flatMap(a => [a.bufferView, a.sparse?.indices?.bufferView, a.sparse?.values?.bufferView]).filter(Number.isSafeInteger));
  let totalBeforePixels = 0, totalAfterPixels = 0;
  for (const [imageIndex, image] of json.images.entries()) {
    assert.equal(image.uri, undefined, 'Only bufferView-embedded textures are supported');
    assert.ok(['image/png', 'image/jpeg'].includes(image.mimeType), 'Only embedded PNG/JPEG textures are supported');
    assert.ok(!geometryViews.has(image.bufferView), 'An image cannot share a bufferView with geometry');
    const bytes = viewBytes(original, image.bufferView), metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 128 * 1024 * 1024 }).metadata();
    assert.equal(metadata.format, image.mimeType === 'image/png' ? 'png' : 'jpeg', 'Image MIME mismatch');
    assert.ok(metadata.width > 0 && metadata.height > 0 && metadata.depth === 'uchar', 'Expected an 8-bit texture');
    assert.ok(!metadata.orientation || metadata.orientation === 1, 'Oriented images need explicit review');
    assert.ok(!metadata.hasProfile, 'ICC-profile textures need explicit color-management review');
    const scale = Math.min(1, maxEdge / Math.max(metadata.width, metadata.height));
    const width = Math.max(1, Math.round(metadata.width * scale)), height = Math.max(1, Math.round(metadata.height * scale));
    let optimized = replacements.get(image.bufferView);
    if (!optimized) {
      optimized = bytes;
      if (scale < 1) {
        const pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 128 * 1024 * 1024 }).resize(width, height, { fit: 'fill', withoutEnlargement: true, kernel: 'lanczos3' });
        // Keep format; JPEG uses 4:4:4 to avoid chroma subsampling between ORM data channels.
        optimized = image.mimeType === 'image/png' ? await pipeline.png({ compressionLevel: 9, palette: false }).toBuffer()
          : await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
      }
      replacements.set(image.bufferView, optimized);
    }
    const after = await sharp(optimized).metadata();
    assert.equal(after.width, width); assert.equal(after.height, height); assert.equal(after.hasAlpha, metadata.hasAlpha);
    totalBeforePixels += metadata.width * metadata.height; totalAfterPixels += width * height; imageViews.add(image.bufferView);
    images.push({ index: imageIndex, name: image.name || '', bufferView: image.bufferView, mimeType: image.mimeType,
      resized: scale < 1, before: { width: metadata.width, height: metadata.height, bytes: bytes.length, sha256: hash(bytes) },
      after: { width, height, bytes: optimized.length, sha256: hash(optimized) },
      channels: metadata.channels, alphaPreserved: true, kernel: scale < 1 ? 'lanczos3' : null,
      encoding: scale < 1 ? image.mimeType === 'image/jpeg' ? 'JPEG quality 95, 4:4:4' : 'PNG lossless, compression 9' : 'original bytes' });
  }
  assert.ok(totalAfterPixels <= MAX_PIXELS, 'Resized textures still exceed the unchanged loader pixel budget');
  const parts = []; let cursor = 0;
  for (const [i, view] of json.bufferViews.entries()) {
    const data = replacements.get(i) || viewBytes(original, i), padding = align4(cursor) - cursor;
    if (padding) { parts.push(Buffer.alloc(padding)); cursor += padding; }
    view.byteOffset = cursor; view.byteLength = data.length; parts.push(data); cursor += data.length;
  }
  json.buffers[0].byteLength = cursor;
  const runtimeBytes = packageGLB(original, json, Buffer.concat(parts)), runtime = parseGLB(runtimeBytes), checks = verify(original, runtime, imageViews);
  const record = { schemaVersion: 1, operation: 'technical-texture-downscale', generatedAt: new Date().toISOString(),
    source: { file: path.basename(input), bytes: originalBytes.length, sha256: originalHash },
    runtime: { file: path.basename(output), bytes: runtimeBytes.length, sha256: hash(runtimeBytes) },
    settings: { maxEdge, maxTotalPixels: MAX_PIXELS, allowUpscale: false, preserveOriginal: true },
    tool: { node: process.version, sharp: sharp.versions.sharp, libvips: sharp.versions.vips },
    totalBeforePixels, totalAfterPixels, images, verification: checks,
    note: 'Only texture raster resolution/encoding and BIN packing changed. No geometry, topology, UV, transform, material or scene edits; no generative redraw. JPEG re-encoding is lossy. Visual approval is separate.' };
  assert.equal(hash(fs.readFileSync(input)), originalHash, 'Source changed during preparation');
  const ownedTemps = [];
  try {
    for (const [target, data] of [[output, runtimeBytes], [reportPath, Buffer.from(JSON.stringify(record, null, 2) + '\n')]]) {
      const temp = target + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(temp, data, { flag: 'wx' }); ownedTemps.push({ temp, target });
    }
    for (const item of ownedTemps) { fs.renameSync(item.temp, item.target); item.renamed = true; }
  } finally {
    for (const item of ownedTemps) if (!item.renamed) try { fs.unlinkSync(item.temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(hash(fs.readFileSync(input)), originalHash, 'Original must remain byte-identical');
  return record;
}
if (require.main === module) {
  const [input, output, edge] = process.argv.slice(2);
  if (!input) { console.error('Usage: prepare-character.cjs SOURCE.glb [model.runtime.glb] [MAX_EDGE<=2048]'); process.exitCode = 1; }
  else prepare(input, output, edge === undefined ? 2048 : Number(edge)).then(record => console.log(JSON.stringify({ source: record.source, runtime: record.runtime, totalBeforePixels: record.totalBeforePixels, totalAfterPixels: record.totalAfterPixels, verifiedUnchangedGeometry: record.verification.nonImageBufferViewsByteIdentical }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepare, parseGLB, verify };
