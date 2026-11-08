import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEventStore, EventStoreError } from '../server/event-store.mjs';

// All files below are synthetic and live only in newly created test directories.
const DAY = 86400000, NOW = 100 * DAY;
const event = (t = NOW, extra = {}) => ({ id: randomUUID(), sessionId: 's_anonymous_test_123456', lesson: 'nev-l4', t, type: 'answer', payload: { station: 'a', target: '发动机', correct: true }, ...extra });
const line = (value) => JSON.stringify(value) + '\n';
const hasCode = (code) => (e) => e instanceof EventStoreError && e.code === code && e.message === code;
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), file = path.join(dataDir, 'learning-events.jsonl');
  return { dir, dataDir, file, store: createEventStore({ dataDir, now: () => NOW, ...options }) };
}
async function writeFixture(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
async function ids(store) { const output = []; await store.scan((item) => output.push(item.id)); return output; }

test('new directory stays absent during status/scan, then a valid append creates exactly the event file', async (t) => {
  const { dataDir, store } = await setup(t);
  const status = await store.status(); assert.equal(status.retentionDays, 30); assert.equal(status.maxBytes, 67108864); assert.equal(status.bytes, 0);
  assert.deepEqual(await ids(store), []); await assert.rejects(() => fs.stat(dataDir), { code: 'ENOENT' });
  const e = event(); assert.deepEqual(await store.append(e), { ok: true, stored: true, id: e.id });
  assert.deepEqual(await ids(store), [e.id]); assert.deepEqual(await fs.readdir(dataDir), ['learning-events.jsonl']);
  assert.equal((await store.status()).retainedRows, 1); assert.ok(!JSON.stringify(await store.status()).includes(dataDir));
});

test('pruning removes only strictly expired valid events; boundary, current, future and all unknown rows remain byte-for-byte', async (t) => {
  const { file, store } = await setup(t);
  const old = event(NOW - 30 * DAY - 1), boundary = event(NOW - 30 * DAY), recent = event(), future = event(NOW + DAY);
  const unknown = { ...event(0), futureSchema: 'keep-this-unknown-row' }, bad = '{not-json}\r\n', unknownType = { ...event(0), type: 'future_event_type' };
  const kept = line(boundary) + bad + line(unknown) + line(recent).replace(/\n$/, '\r\n') + line(future) + line(unknownType);
  await writeFixture(file, line(old) + kept);
  const before = await store.status(); assert.equal(before.expiredRows, 1); assert.equal(before.invalidRows, 3);
  assert.equal(await fs.readFile(file, 'utf8'), line(old) + kept); // status is read-only.
  assert.deepEqual(await ids(store), [boundary.id, recent.id, future.id]);
  assert.equal(await fs.readFile(file, 'utf8'), kept);
  const status = await store.status(); assert.equal(status.prunedRows, 1); assert.equal(status.invalidRows, 3); assert.equal(status.expiredRows, 0);
});

test('overlong and malformed UTF-8 rows are preserved in bounded chunks, and replacement waits until handles close', async (t) => {
  const { file, dataDir } = await setup(t);
  const old = event(0), recent = event();
  const unknown = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 120), Buffer.from('\n'), Buffer.from([0xff, 0xfe, 10])]);
  await writeFixture(file, Buffer.concat([Buffer.from(line(old)), unknown, Buffer.from(line(recent))]));
  let active = 0, largestRead = 0, renamed = false;
  const io = { ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args); active++;
      return new Proxy(handle, { get(target, property) {
        if (property === 'close') return async () => { await target.close(); active--; };
        if (property === 'read') return async (...params) => { largestRead = Math.max(largestRead, params[2]); return target.read(...params); };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    rename: async (...args) => { assert.equal(active, 0); renamed = true; return fs.rename(...args); },
  };
  const store = createEventStore({ dataDir, now: () => NOW }, { fileSystem: io });
  assert.deepEqual(await ids(store), [recent.id]); assert.ok(renamed); assert.ok(largestRead <= 65536);
  assert.deepEqual(await fs.readFile(file), Buffer.concat([unknown, Buffer.from(line(recent))]));
  const status = await store.status(); assert.equal(status.invalidRows, 2); assert.equal(status.overlongRows, 1); assert.equal(active, 0);
});

test('retention zero disables new writes without pruning or creating directories, while existing valid events remain readable', async (t) => {
  const { file, dataDir, store } = await setup(t, { retentionDays: 0 });
  assert.deepEqual(await store.append(event()), { ok: true, stored: false, reason: 'storage_disabled' });
  await assert.rejects(() => fs.stat(dataDir), { code: 'ENOENT' });
  const old = event(0), raw = line(old) + '{keep bad row}'; await writeFixture(file, raw);
  assert.deepEqual(await ids(store), [old.id]); await store.append(event());
  const status = await store.status(); assert.equal(status.enabled, false); assert.equal(status.invalidRows, 1); assert.equal(status.prunedRows, 0); assert.equal(status.expiredRows, 0);
  assert.equal(await fs.readFile(file, 'utf8'), raw); assert.deepEqual(await fs.readdir(dataDir), ['learning-events.jsonl']);
});

test('capacity allows exact fit then returns storage_full without deleting recent or unknown rows', async (t) => {
  const { file, dataDir } = await setup(t), first = event(), capacity = Buffer.byteLength(line(first));
  const store = createEventStore({ dataDir, now: () => NOW, maxBytes: capacity });
  await store.append(first); const original = await fs.readFile(file);
  await assert.rejects(() => store.append(event()), hasCode('storage_full'));
  assert.deepEqual(await fs.readFile(file), original); assert.equal((await store.status()).capacityReached, true);
  await fs.writeFile(file, 'unknown'.repeat(capacity));
  const unknown = await fs.readFile(file); await assert.rejects(() => store.append(event()), hasCode('storage_full'));
  assert.deepEqual(await fs.readFile(file), unknown); assert.equal((await store.status()).invalidRows, 1);
});

test('expired events can reclaim capacity, but an already expired new event is explicitly not stored', async (t) => {
  const { file, dataDir } = await setup(t), recent = event();
  await writeFixture(file, line(event(0)));
  const store = createEventStore({ dataDir, now: () => NOW, maxBytes: Buffer.byteLength(line(recent)) });
  await store.append(recent); assert.deepEqual(await ids(store), [recent.id]);
  assert.deepEqual(await store.append(event(0)), { ok: true, stored: false, reason: 'event_expired' });
  assert.deepEqual(await ids(store), [recent.id]);
});

test('append preserves an unterminated existing line and accounts for its separating newline in capacity', async (t) => {
  const { file, dataDir } = await setup(t), first = event(), second = event(), raw = JSON.stringify(first);
  await writeFixture(file, raw);
  const total = Buffer.byteLength(raw + '\n' + line(second));
  const tight = createEventStore({ dataDir, now: () => NOW, maxBytes: total - 1 });
  await assert.rejects(() => tight.append(second), hasCode('storage_full')); assert.equal(await fs.readFile(file, 'utf8'), raw);
  const fitting = createEventStore({ dataDir, now: () => NOW, maxBytes: total });
  await fitting.append(second); assert.equal(await fs.readFile(file, 'utf8'), raw + '\n' + line(second));
  assert.deepEqual(await ids(fitting), [first.id, second.id]);
});

test('concurrent append/scan across two store handles serializes without dropped writes or partial records', async (t) => {
  const { dataDir, store } = await setup(t), other = createEventStore({ dataDir, now: () => NOW });
  const events = Array.from({ length: 80 }, () => event()), work = [], observedPrefixes = [];
  for (let i = 0; i < events.length; i++) {
    work.push((i % 2 ? other : store).append(events[i]));
    if (i % 10 === 9) work.push(other.scan(async (e) => { await Promise.resolve(); observedPrefixes.push(e.id); }));
  }
  await Promise.all(work);
  assert.deepEqual(await ids(store), events.map((e) => e.id)); assert.equal((await store.status()).invalidRows, 0);
  assert.equal(observedPrefixes.length, 10 + 20 + 30 + 40 + 50 + 60 + 70 + 80);
});

test('cached expiry reacts to clock advance, exact boundaries and rollback; invalid clocks do not poison subsequent operations', async (t) => {
  const { dataDir } = await setup(t); let clock = NOW;
  const store = createEventStore({ dataDir, retentionDays: 1, now: () => clock }), first = event(clock);
  await store.append(first); clock += DAY; assert.deepEqual(await ids(store), [first.id]);
  clock++; assert.deepEqual(await ids(store), []);
  const future = event(clock); await store.append(future); clock -= 2 * DAY;
  assert.deepEqual(await ids(store), [future.id]);
  clock = NaN; await assert.rejects(() => store.status(), hasCode('storage_invalid_clock'));
  clock = NOW; assert.deepEqual(await ids(store), [future.id]);
});

test('append snapshots trusted input before queuing and rejects raw/uncontrolled fields', async (t) => {
  const { store } = await setup(t), item = event(); const promise = store.append(item);
  item.payload.target = 'changed after append'; item.t = 0; await promise;
  let saved; await store.scan((e) => { saved = e; }); assert.equal(saved.payload.target, '发动机'); assert.equal(saved.t, NOW);
  for (const bad of [{ ...event(), name: 'synthetic-private-field' }, { ...event(), t: 'old' }, event(NOW, { payload: { transcript: 'synthetic text' } }), event(NOW, { payload: { audio: 'synthetic bytes' } }), event(NOW, { sessionId: 'plain-name' }), event(NOW, { type: 'unrecognized' })]) {
    await assert.rejects(() => store.append(bad), hasCode('storage_invalid_event'));
  }
  assert.equal((await store.status()).validRows, 1);
});

test('callback errors are sanitized; reentrant queue operations fail without deadlock; later writes still succeed', async (t) => {
  const { store } = await setup(t); await store.append(event());
  await assert.rejects(() => store.scan(() => { throw new Error('synthetic-private-content'); }), hasCode('storage_scan_callback'));
  await assert.rejects(() => store.scan(async () => { await store.append(event()); }), hasCode('storage_scan_callback'));
  await assert.rejects(() => store.scan(null), hasCode('storage_invalid_callback'));
  await store.append(event()); assert.equal((await ids(store)).length, 2);
});

test('directory/file confusion and hard links are refused; no unrelated paths are modified', async (t) => {
  const { dir, dataDir, file, store } = await setup(t);
  await fs.writeFile(dataDir, 'not a directory'); await assert.rejects(() => store.status(), hasCode('storage_unsafe_path'));
  assert.equal(await fs.readFile(dataDir, 'utf8'), 'not a directory'); await fs.unlink(dataDir);
  await fs.mkdir(file, { recursive: true }); await assert.rejects(() => store.append(event()), hasCode('storage_unsafe_path'));
  await fs.rmdir(file);
  const target = path.join(dir, 'unrelated.jsonl'); await fs.writeFile(target, line(event())); await fs.link(target, file);
  const original = await fs.readFile(target); await assert.rejects(() => store.scan(() => {}), hasCode('storage_unsafe_path'));
  assert.deepEqual(await fs.readFile(target), original);
});

test('atomic replace failure preserves the original and removes only the temporary file created by this prune', async (t) => {
  const { file, dataDir } = await setup(t), original = line(event(0)) + line(event()) + '{unknown}\n';
  await writeFixture(file, original);
  const unrelated = path.join(dataDir, 'learning-events.jsonl.prune-other-owner.tmp'); await fs.writeFile(unrelated, 'leave alone');
  const removed = [];
  const store = createEventStore({ dataDir, now: () => NOW }, { fileSystem: { ...fs,
    rename: async () => { throw new Error('synthetic path and private error'); },
    unlink: async (target) => { removed.push(target); return fs.unlink(target); },
  } });
  await assert.rejects(() => store.scan(() => {}), hasCode('storage_io_error'));
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(await fs.readFile(unrelated, 'utf8'), 'leave alone');
  assert.equal(removed.length, 1); assert.equal(path.dirname(removed[0]), dataDir); assert.ok(path.basename(removed[0]).startsWith(`learning-events.jsonl.prune-${process.pid}-`));
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['learning-events.jsonl', path.basename(unrelated)].sort());
});

test('detected external change during prune prevents replacement rather than losing the newly written event', async (t) => {
  const { file, dataDir } = await setup(t), original = line(event(0)) + line(event()), added = line(event());
  await writeFixture(file, original); let changed = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); if (!String(args[0]).endsWith('.tmp')) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { await target.sync(); if (!changed) { changed = true; await fs.appendFile(file, added); } };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const store = createEventStore({ dataDir, now: () => NOW }, { fileSystem: io });
  await assert.rejects(() => store.scan(() => {}), hasCode('storage_io_error'));
  assert.equal(await fs.readFile(file, 'utf8'), original + added); assert.deepEqual(await fs.readdir(dataDir), ['learning-events.jsonl']);
});

test('partial append failure attempts rollback to the previous length and does not poison the queue', async (t) => {
  const { file, dataDir } = await setup(t), original = line(event()); await writeFixture(file, original);
  let calls = 0, failing = true;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'write') return async (buffer, offset, length, position) => {
        if (!failing) return target.write(buffer, offset, length, position);
        if (++calls === 1) return target.write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        throw Object.assign(new Error('private disk detail'), { code: 'ENOSPC' });
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const store = createEventStore({ dataDir, now: () => NOW }, { fileSystem: io });
  await assert.rejects(() => store.append(event()), hasCode('storage_full')); assert.equal(await fs.readFile(file, 'utf8'), original);
  failing = false; await store.append(event()); assert.equal((await ids(store)).length, 2);
});

test('unknown records carrying old timestamps and payload extensions are neither pruned nor exposed to callbacks', async (t) => {
  const { file, store } = await setup(t);
  const unknown = event(0, { payload: { extension: { marker: 'synthetic-secret-marker' } } });
  const recent = event(), bytes = line(unknown) + line(recent); await writeFixture(file, bytes);
  assert.deepEqual(await ids(store), [recent.id]); const status = await store.status();
  assert.equal(status.invalidRows, 1); assert.ok(!JSON.stringify(status).includes('synthetic-secret-marker')); assert.equal(await fs.readFile(file, 'utf8'), bytes);
});
