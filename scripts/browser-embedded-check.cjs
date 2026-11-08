// Verify an explicitly supplied test HTML with an embedded point cloud.
// No asset download, live provider or target-hardware performance claim.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

(async () => {
  assert.ok(process.argv[2], 'Usage: node scripts/browser-embedded-check.cjs <test.html> <expected-points> [output-dir]');
  const input = path.resolve(process.argv[2]), expected = Number(process.argv[3]);
  assert.ok(Number.isInteger(expected) && expected >= 25000 && expected <= 2000000);
  const output = path.resolve(process.argv[4] || 'artifacts/splat-embedded');
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-embedded-'));
  const standalone = path.join(directory, '独立点云课件.html');
  fs.copyFileSync(input, standalone);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(input), hash(standalone));
  assert.deepEqual(fs.readdirSync(directory), [path.basename(standalone)]);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, offline: true });
    const errors = [], network = [], localDependencies = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url())) network.push(request.url());
      if (request.url().startsWith('file:') && new URL(request.url()).pathname !== pathToFileURL(standalone).pathname) localDependencies.push(request.url());
    });
    const url = pathToFileURL(standalone); url.searchParams.set('debug', '1');
    await page.goto(url.href);
    await page.locator('[data-lv="2"]').click();
    await page.evaluate(() => { window.__cdg.ST.sound = false; window.speechSynthesis?.cancel(); });
    await page.waitForFunction(() => window.__cdg?.dbg.MAR.loaded, { timeout: 30000 });
    const loaded = await page.evaluate(() => {
      const { R, MAR } = window.__cdg.dbg, gl = R.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { name: MAR.name, meta: R.splat.getMetadata(), error: gl.getError(), meshes: window.__cdg.W.car.root.children.length,
        navigatorOnline: navigator.onLine, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    });
    assert.equal(loaded.meta.sourcePoints, expected); assert.ok(loaded.meta.activePoints > 0 && loaded.meta.activePoints <= expected);
    assert.equal(loaded.error, 0); assert.ok(loaded.meshes > 0); assert.equal(loaded.navigatorOnline, false);
    await page.locator('[data-t="scene"]').click();
    await page.locator('[data-auto-lod]').uncheck();
    const qualities = [];
    for (const budget of [25000, 100000]) {
      await page.locator('[data-point-budget]').selectOption(String(budget));
      const state = await page.evaluate(() => ({ meta: window.__cdg.dbg.R.splat.getMetadata(), error: window.__cdg.dbg.R.gl.getError(), meshes: window.__cdg.W.car.root.children.length }));
      assert.equal(state.meta.activePoints, Math.min(expected, budget)); assert.equal(state.error, 0); assert.equal(state.meshes, loaded.meshes);
      qualities.push(state.meta.activePoints);
    }
    await page.screenshot({ path: path.join(output, 'embedded-synthetic-points.png') });
    await page.locator('[data-sx]').click();
    await page.locator('[data-t="ask"]').click();
    await page.locator('.npc-form input').fill('纯电动汽车有发动机吗？');
    await page.locator('.npc-form button').click();
    await page.locator('.npc-line').waitFor();
    const answer = await page.locator('.npc-line').evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('rt').forEach(rt => rt.remove()); return copy.textContent; });
    assert.match(answer, /没有发动机/);
    assert.equal(await page.locator('.npc-answer .seal').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(localDependencies, []);
    const report = { testedAt: new Date().toISOString(), browserVersion: browser.version(), input: path.basename(input), standalone,
      bytes: fs.statSync(standalone).size, sha256: hash(standalone), loaded, qualities, answer, errors, network, localDependencies,
      syntheticInput: true, originalFactory: false, targetIntegratedGpuAcceptance: false, realVoiceTested: false, realModelTested: false };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ sourcePoints: loaded.meta.sourcePoints, qualities, meshes: loaded.meshes, offline: !loaded.navigatorOnline, errors, network, localDependencies }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
