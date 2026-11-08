import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const FILE_NAME = 'learning-events.jsonl';
const DAY = 86400000;
const CHUNK_BYTES = 65536;
const MAX_LINE_BYTES = 65536;
const queues = new Map();
const callbackContext = new AsyncLocalStorage();
const TYPES = new Set(['session_start', 'station_enter', 'prompt_shown', 'speak_attempt', 'pronunciation_attempt', 'answer', 'hint_used', 'word_card_open', 'evidence_open', 'plug_toggle', 'session_finish']);
const NUMBERS = new Set(['level', 'score', 'overall', 'attempt', 'spoken', 'hints', 'evidenceCount', 'durationMs', 'duration', 'elapsedMs']);
const BOOLEANS = new Set(['plugged', 'asrOk', 'ok', 'correct', 'online']);
const LABELS = new Set(['station', 'step', 'target', 'word', 'evidenceId', 'inputMethod', 'inputMode', 'capability']);
const ROOT_FIELDS = new Set(['id', 'sessionId', 'lesson', 't', 'type', 'payload']);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const decoder = new TextDecoder('utf-8', { fatal: true });

export class EventStoreError extends Error {
  constructor(code) { super(code); this.name = 'EventStoreError'; this.code = code; }
}
const error = (code) => new EventStoreError(code);
function storageError(e) { return e instanceof EventStoreError ? e : error(e?.code === 'ENOSPC' ? 'storage_full' : 'storage_io_error'); }
function validEvent(e) {
  if (!plain(e) || Object.keys(e).length !== 6 || Object.keys(e).some((k) => !ROOT_FIELDS.has(k))) return false;
  if (typeof e.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.id)) return false;
  if (typeof e.sessionId !== 'string' || !/^s_[A-Za-z0-9_-]{12,80}$/.test(e.sessionId) || !identifier(e.lesson)
    || !Number.isSafeInteger(e.t) || e.t < 0 || !TYPES.has(e.type) || !plain(e.payload)) return false;
  for (const [key, value] of Object.entries(e.payload)) {
    if (NUMBERS.has(key)) { if (!Number.isFinite(value) || value < 0 || value > DAY) return false; }
    else if (BOOLEANS.has(key)) { if (typeof value !== 'boolean') return false; }
    else if (LABELS.has(key)) {
      if (typeof value !== 'string' || value.length > 80 || /[<>@\r\n\u0000-\u001f]/.test(value) || /\d{7,}/.test(value)) return false;
      if (['station', 'step', 'evidenceId'].includes(key) && value && !identifier(value)) return false;
      if (['inputMode', 'inputMethod'].includes(key) && !['text', 'choice', 'browser_asr', 'cloud_asr'].includes(value)) return false;
      if (key === 'capability' && !['L1', 'L2', 'unavailable', 'browser'].includes(value)) return false;
    } else return false;
  }
  return true;
}
function parseEvent(line) {
  try { const value = JSON.parse(decoder.decode(line)); return validEvent(value) ? value : null; } catch { return null; }
}
function snapshot(event) {
  if (!validEvent(event)) throw error('storage_invalid_event');
  let line;
  try { line = Buffer.from(JSON.stringify(event) + '\n'); } catch { throw error('storage_invalid_event'); }
  if (line.length > MAX_LINE_BYTES || !parseEvent(line)) throw error('storage_invalid_event');
  return { line, event: JSON.parse(line.toString('utf8')) };
}
// Windows libuv may return dev=0 from path stat but the volume id from fstat.
// Use exact bigint file ids (NTFS ids can exceed Number.MAX_SAFE_INTEGER).
const fileStamp = (s) => `${process.platform === 'win32' ? 'windows' : s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const sameIdentity = (a, b) => a.ino === b.ino && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
const fileSize = (s) => { const n = Number(s.size); if (!Number.isSafeInteger(n) || n < 0) throw error('storage_io_error'); return n; };
function safeRegularFile(stat) { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= 1; }
const emptyStats = () => ({ bytes: 0, validRows: 0, retainedRows: 0, expiredRows: 0, invalidRows: 0, overlongRows: 0, minTimestamp: null });

async function writeAll(handle, bytes, onProgress) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw error('storage_io_error');
    offset += bytesWritten;
    onProgress?.(offset);
  }
}

/** Stream even malformed, newline-free files without keeping an unbounded line in memory. */
async function walk(handle, cutoff, { sink, onEvent } = {}) {
  const stats = emptyStats(), buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending = [], pendingBytes = 0, overlong = false;
  async function finishLine() {
    if (overlong) { stats.invalidRows++; stats.overlongRows++; }
    else {
      const raw = Buffer.concat(pending, pendingBytes), event = parseEvent(raw);
      const expired = event && cutoff !== null && event.t < cutoff;
      if (!event) stats.invalidRows++;
      else {
        stats.validRows++;
        stats.minTimestamp = stats.minTimestamp === null ? event.t : Math.min(stats.minTimestamp, event.t);
        if (expired) stats.expiredRows++; else stats.retainedRows++;
      }
      if (!expired && sink) await writeAll(sink, raw);
      if (event && !expired && onEvent) await onEvent(event);
    }
    pending = []; pendingBytes = 0; overlong = false;
  }
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    stats.bytes += bytesRead; let offset = 0;
    while (offset < bytesRead) {
      const index = buffer.indexOf(10, offset), newline = index >= 0 && index < bytesRead;
      const end = newline ? index + 1 : bytesRead;
      // Copy only one bounded fragment; the shared read buffer is reused on the next iteration.
      const part = Buffer.from(buffer.subarray(offset, end));
      if (overlong) { if (sink) await writeAll(sink, part); }
      else if (pendingBytes + part.length > MAX_LINE_BYTES) {
        overlong = true;
        if (sink) { for (const fragment of pending) await writeAll(sink, fragment); await writeAll(sink, part); }
        pending = []; pendingBytes = 0;
      } else { pending.push(part); pendingBytes += part.length; }
      if (newline) await finishLine();
      offset = end;
    }
  }
  if (overlong || pendingBytes) await finishLine();
  return stats;
}

/** One file, one process. Pass only events already returned by the service's cleanEvent(). */
export function createEventStore({ dataDir, retentionDays = 30, maxBytes = 67108864, now = Date.now } = {}, { fileSystem = fs } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || !Number.isFinite(retentionDays) || retentionDays < 0 || retentionDays > 36500
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || typeof now !== 'function') throw error('storage_invalid_config');
  const directory = path.resolve(dataDir), file = path.join(directory, FILE_NAME), key = process.platform === 'win32' ? file.toLowerCase() : file;
  let cache = null, prunedRows = 0, lastPruneAt = null, cleanupWarning = false;
  function time() { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw error('storage_invalid_clock'); return value; }
  const cutoffAt = (at) => retentionDays === 0 ? null : at - retentionDays * DAY;
  function enqueue(operation) {
    const context = callbackContext.getStore();
    if (context?.active && context.key === key) return Promise.reject(error('storage_reentrant'));
    const previous = queues.get(key) || Promise.resolve();
    const task = previous.then(operation).catch((e) => { throw storageError(e); });
    const tail = task.catch(() => {}); queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return task;
  }
  async function root(create = false) {
    let stat;
    try { stat = await fileSystem.lstat(directory, { bigint: true }); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!create) return false;
      await fileSystem.mkdir(directory, { recursive: true }); stat = await fileSystem.lstat(directory, { bigint: true });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('storage_unsafe_path');
    return true;
  }
  async function fileInfo() {
    if (!await root()) return null;
    try { const stat = await fileSystem.lstat(file, { bigint: true }); if (!safeRegularFile(stat)) throw error('storage_unsafe_path'); return stat; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function openRead() {
    const before = await fileInfo(); if (!before) return null;
    const handle = await fileSystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat({ bigint: true }), after = await fileInfo();
      if (!after || !safeRegularFile(stat) || !sameIdentity(before, stat) || !sameIdentity(stat, after)) throw error('storage_unsafe_path');
      return { handle, stat };
    } catch (e) { await handle.close(); throw e; }
  }
  async function inspect(cutoff, onEvent) {
    const opened = await openRead();
    if (!opened) { cache = { stamp: null, stats: emptyStats() }; return cache.stats; }
    const { handle, stat } = opened;
    try {
      const stats = await walk(handle, cutoff, { onEvent });
      if (stats.bytes !== fileSize(stat) || fileStamp(await handle.stat({ bigint: true })) !== fileStamp(stat)) throw error('storage_io_error');
      cache = { stamp: fileStamp(stat), stats };
      return stats;
    } finally { await handle.close(); }
  }
  async function prune(at) {
    if (retentionDays === 0) return;
    const cutoff = cutoffAt(at), existing = await fileInfo();
    if (!existing) { cache = { stamp: null, stats: emptyStats() }; return; }
    if (cache?.stamp === fileStamp(existing) && (cache.stats.minTimestamp === null || cache.stats.minTimestamp >= cutoff)) return;
    const stats = await inspect(cutoff);
    if (!stats.expiredRows) return;
    let source, temporary, tempPath, created = false, replaced = false;
    try {
      source = await openRead(); if (!source) throw error('storage_io_error');
      tempPath = path.join(directory, `${FILE_NAME}.prune-${process.pid}-${randomUUID()}.tmp`);
      temporary = await fileSystem.open(tempPath, 'wx', 0o600); created = true;
      const copied = await walk(source.handle, cutoff, { sink: temporary });
      if (copied.bytes !== fileSize(source.stat) || fileStamp(await source.handle.stat({ bigint: true })) !== fileStamp(source.stat)) throw error('storage_io_error');
      await temporary.sync(); await temporary.close(); temporary = null;
      await source.handle.close(); source.handle = null;
      const current = await fileInfo();
      if (!current || fileStamp(current) !== fileStamp(source.stat)) throw error('storage_io_error');
      // Both handles are closed. A failed rename leaves the original intact; there is no delete-first step.
      await fileSystem.rename(tempPath, file); replaced = true;
      prunedRows += copied.expiredRows; lastPruneAt = at; cache = null;
    } finally {
      try { await temporary?.close(); } catch { cleanupWarning = true; }
      try { await source?.handle?.close(); } catch { cleanupWarning = true; }
      if (created && !replaced) {
        try { await fileSystem.unlink(tempPath); } catch (e) { if (e.code !== 'ENOENT') cleanupWarning = true; }
      }
    }
  }
  async function openAppend() {
    await root(true); const before = await fileInfo();
    let handle;
    try {
      const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0) | (before ? 0 : constants.O_CREAT | constants.O_EXCL);
      handle = await fileSystem.open(file, flags, 0o600);
      const stat = await handle.stat({ bigint: true }), current = await fileInfo();
      if (!current || !safeRegularFile(stat) || !sameIdentity(stat, current) || before && !sameIdentity(before, stat)) throw error('storage_unsafe_path');
      return { handle, stat };
    } catch (e) { await handle?.close(); throw e; }
  }
  function append(value) {
    let item;
    try { item = snapshot(value); } catch (e) { return Promise.reject(storageError(e)); }
    return enqueue(async () => {
      const at = time();
      if (retentionDays === 0) return { ok: true, stored: false, reason: 'storage_disabled' };
      await prune(at);
      if (item.event.t < cutoffAt(at)) return { ok: true, stored: false, reason: 'event_expired' };
      // Read the last byte with a read-only handle; append mode itself remains write-only.
      const opened = await openRead(); let size = 0, separator = false;
      if (opened) {
        try {
          size = fileSize(opened.stat);
          if (size) { const last = Buffer.alloc(1); await opened.handle.read(last, 0, 1, size - 1); separator = last[0] !== 10; }
        } finally { await opened.handle.close(); }
      }
      const needed = item.line.length + (separator ? 1 : 0);
      if (size + needed > maxBytes) throw error('storage_full');
      const { handle, stat } = await openAppend();
      try {
        if (fileSize(stat) !== size) throw error('storage_io_error');
        const previousStats = size === 0 ? emptyStats() : cache?.stamp === fileStamp(stat) ? cache.stats : null;
        const bytes = separator ? Buffer.concat([Buffer.from('\n'), item.line]) : item.line;
        let written = 0;
        try { await writeAll(handle, bytes, (count) => { written = count; }); }
        catch (e) {
          // Windows append-only handles may not permit truncate. Roll back only our known
          // partial suffix, using a verified read/write handle; never truncate a changed file.
          let rollback;
          try {
            const current = await fileInfo();
            if (!current || !sameIdentity(current, stat) || fileSize(current) !== size + written) throw error('storage_io_error');
            rollback = await fileSystem.open(file, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
            const opened = await rollback.stat({ bigint: true });
            if (!safeRegularFile(opened) || !sameIdentity(opened, stat) || fileSize(opened) !== size + written) throw error('storage_io_error');
            await rollback.truncate(size);
          } catch { cleanupWarning = true; }
          finally { try { await rollback?.close(); } catch { cleanupWarning = true; } }
          cache = null; throw e;
        }
        cache = previousStats ? { stamp: fileStamp(await handle.stat({ bigint: true })), stats: { ...previousStats, bytes: size + bytes.length,
          validRows: previousStats.validRows + 1, retainedRows: previousStats.retainedRows + 1,
          minTimestamp: previousStats.minTimestamp === null ? item.event.t : Math.min(previousStats.minTimestamp, item.event.t) } } : null;
      } finally { await handle.close(); }
      return { ok: true, stored: true, id: item.event.id };
    });
  }
  function scan(onEvent) {
    if (typeof onEvent !== 'function') return Promise.reject(error('storage_invalid_callback'));
    return enqueue(async () => {
      const at = time(); await prune(at); let scanned = 0;
      const stats = await inspect(cutoffAt(at), async (event) => {
        const context = { key, active: true };
        try { await callbackContext.run(context, () => onEvent(event)); scanned++; }
        catch { throw error('storage_scan_callback'); }
        finally { context.active = false; }
      });
      return { ok: true, scanned, bytes: stats.bytes, invalidRows: stats.invalidRows, overlongRows: stats.overlongRows, expiredRows: stats.expiredRows };
    });
  }
  function status() {
    return enqueue(async () => {
      const at = time(), stats = await inspect(cutoffAt(at));
      return { ok: true, enabled: retentionDays > 0, retentionDays, maxBytes, bytes: stats.bytes, validRows: stats.validRows,
        retainedRows: stats.retainedRows, expiredRows: stats.expiredRows, invalidRows: stats.invalidRows, overlongRows: stats.overlongRows,
        capacityReached: stats.bytes >= maxBytes, prunedRows, lastPruneAt, cleanupWarning };
    });
  }
  return { append, scan, status };
}
