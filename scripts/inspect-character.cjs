// Inspect a downloaded GLB with the same renderer used by the classroom.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const [file, heightArg, outArg] = process.argv.slice(2);
(async () => {
  if (!file || !heightArg || !outArg) throw new Error('Usage: inspect-character.cjs MODEL.glb HEIGHT OUTPUT_DIRECTORY');
  const bytes = fs.readFileSync(file), height = Number(heightArg), out = path.resolve(outArg);
  assert.ok(Number.isFinite(height) && height > 0 && height <= 3);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 800, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html><body style="margin:0"><canvas id="view" style="width:800px;height:900px"></canvas></body></html>');
    for (const name of ['engine.js', 'model.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src', name), 'utf8') });
    const report = await page.evaluate(async ({ b64, height }) => {
      const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const model = await CDG_MODEL.loadGLB(data.buffer);
      const root = CDG_MODEL.normalize(model, { height });
      const renderer = new E.Renderer(document.getElementById('view')), camera = new E.Camera();
      renderer.env.clear = [.94, .95, .96]; renderer.env.fogN = 100; renderer.env.fogF = 200;
      camera.target = [0, height * .5, 0]; camera.pitch = .08; camera.dist = height * 2.3; camera.fov = .62;
      const uploaded = renderer.prepareModel(model);
      window.inspection = { model, root, renderer, camera };
      return { bounds: model.bounds, stats: model.stats, warnings: model.warnings, uploaded, height };
    }, { b64: bytes.toString('base64'), height });
    report.views = [];
    for (const [name, yaw] of [['front', 0], ['right', Math.PI/2], ['back', Math.PI], ['left', -Math.PI/2]]) {
      const result = await page.evaluate(yaw => {
        const { renderer, root, camera } = window.inspection;
        camera.yaw = yaw; renderer.render(root, camera);
        return { render: { ...renderer.info.render }, memory: { ...renderer.info.memory }, error: renderer.gl.getError() };
      }, yaw);
      assert.equal(result.error, 0);
      assert.ok(result.render.triangles > 0);
      await page.screenshot({ path: path.join(out, name + '.png') });
      report.views.push({ name, yaw, ...result });
    }
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.inspection.model.dispose(window.inspection.renderer));
    const memoryAfterDispose = await page.evaluate(() => ({ ...window.inspection.renderer.info.memory }));
    assert.equal(memoryAfterDispose.geometries, 0); assert.equal(memoryAfterDispose.textures, 0);
    Object.assign(report, { asset: path.resolve(file), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      browser: browser.version(), testedAt: new Date().toISOString(), errors, memoryAfterDispose });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, ...report.stats, sha256: report.sha256, warnings: report.warnings }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
