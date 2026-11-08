const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
globalThis.E = E;
const characters = require('../src/characters.js');

function fixture() {
  const root = new E.Node(), body = root.add(new E.Node()), head = new E.Node(), tail = new E.Node();
  const world = { dragon: { root, body, head, tail } }, pending = [], disposed = [];
  globalThis.CDG_MODEL = {
    loadGLB(bytes, { signal }) { return new Promise((resolve, reject) => pending.push({ signal, resolve, reject })); },
    normalize(model) { return new E.Node().add(model.root); }
  };
  const renderer = { prepareModel(model) { if (model.rejectUpload) throw new Error('model_texture_size_unsupported'); } };
  const catalog = { default: 'child', characters: [
    { id: 'child', name: '幼年小龙', height: 1.35, b64: 'AQ==' },
    { id: 'youth', name: '青少年小龙', height: 1.8, b64: 'Ag==' }
  ] };
  const manager = characters.create(world, renderer, catalog);
  function finish(index, name, rejectUpload = false) {
    const model = { root: new E.Node(), stats: { name }, rejectUpload, dispose() { disposed.push(name); } };
    pending[index].resolve(model); return model;
  }
  return { world, root, body, head, tail, pending, disposed, manager, finish };
}

test('character replacement keeps the classroom anchor and frees only the old model', async () => {
  const f = fixture();
  const first = f.manager.select('child'); f.finish(0, 'child'); await first;
  assert.equal(f.world.dragon.root, f.root);
  assert.equal(f.body.visible, false);
  const old = f.world.dragon.body;
  const next = f.manager.select('youth');
  assert.equal(f.world.dragon.body, old, 'keep current character while loading');
  f.finish(1, 'youth'); await next;
  assert.equal(f.manager.state.active, 'youth');
  assert.equal(f.world.dragon.height, 1.8);
  assert.deepEqual(f.disposed, ['child']);
  assert.equal(f.root.children.length, 2, 'placeholder and one loaded model only');
  f.manager.close();
  assert.equal(f.body.visible, true);
  assert.equal(f.world.dragon.body, f.body);
  assert.equal(f.world.dragon.head, f.head);
  assert.equal(f.world.dragon.tail, f.tail);
  assert.deepEqual(f.disposed, ['child', 'youth']);
  f.manager.close();
  assert.deepEqual(f.disposed, ['child', 'youth'], 'close is idempotent');
});

test('device upload failure preserves the active character and permits a later retry', async () => {
  const f = fixture();
  const first = f.manager.select('child'); f.finish(0, 'child'); await first;
  const body = f.world.dragon.body;
  const failed = f.manager.select('youth'); f.finish(1, 'broken', true);
  await assert.rejects(failed, /model_texture_size_unsupported/);
  assert.equal(f.world.dragon.body, body);
  assert.equal(f.manager.state.active, 'child');
  assert.equal(f.manager.state.loading, null);
  assert.match(f.manager.state.error, /texture_size/);
  assert.deepEqual(f.disposed, ['broken']);
  const retry = f.manager.select('youth'); f.finish(2, 'youth'); await retry;
  assert.equal(f.manager.state.error, null);
  assert.equal(f.manager.state.active, 'youth');
  assert.deepEqual(f.disposed, ['broken', 'child']);
});

test('late cancelled loads cannot replace the latest selection or resurrect a closed manager', async () => {
  const f = fixture();
  const older = f.manager.select('child'), newer = f.manager.select('youth');
  assert.equal(f.pending[0].signal.aborted, true);
  f.finish(1, 'youth'); await newer;
  f.finish(0, 'late-child'); await older;
  assert.equal(f.manager.state.active, 'youth');
  assert.deepEqual(f.disposed, ['late-child']);
  const after = f.manager.select('child');
  f.manager.close();
  assert.equal(f.pending[2].signal.aborted, true);
  f.finish(2, 'closed-child'); await after;
  assert.equal(f.manager.state.active, null);
  assert.equal(f.root.children.length, 1);
  assert.equal(f.body.visible, true);
  assert.deepEqual(f.disposed, ['late-child', 'youth', 'closed-child']);
});

test('choosing the active character cancels an in-flight switch', async () => {
  const f = fixture();
  const first = f.manager.select('child'); f.finish(0, 'child'); await first;
  const next = f.manager.select('youth');
  await f.manager.select('child');
  assert.equal(f.pending[1].signal.aborted, true);
  f.pending[1].reject(new Error('aborted')); await next;
  assert.equal(f.manager.state.active, 'child');
  assert.equal(f.manager.state.loading, null);
  assert.equal(f.manager.state.error, null);
  assert.deepEqual(f.disposed, []);
});
