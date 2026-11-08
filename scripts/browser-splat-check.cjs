// Actual Edge/WebGL smoke check with a local official-encoded SPZv3 sample.
// This optional sample is NOT the user's factory and is never embedded in the shipping build.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const sample = path.resolve(process.argv[2] || 'artifacts/splat-check/official-v3/official-v3.spz');
  await fs.access(sample);
  const out = path.resolve('artifacts/splat-browser'); await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], externalRequests = []; page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) externalRequests.push(r.url()); });
    const url = pathToFileURL(path.resolve('dist/插电工坊.html')); url.search = '?debug=1';
    await page.goto(url.href); await page.locator('[data-lv="2"]').click();
    await page.evaluate(() => { window.__cdg.ST.sound = false; window.speechSynthesis?.cancel(); });
    await page.locator('[data-t="scene"]').click();
    const start = Date.now();
    await page.locator('[data-file]').setInputFiles(sample);
    await page.waitForFunction(() => window.__cdg.dbg.MAR.loaded, { timeout: 20000 });
    const loadWallMs = Date.now() - start;
    await page.locator('[data-auto-lod]').uncheck();
    const loaded = await page.evaluate(() => {
      const r = window.__cdg.dbg.R, gl = r.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { meta: r.splat.getMetadata(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), error: gl.getError(), carMeshes: window.__cdg.W.car.root.children.length };
    });
    assert.equal(loaded.meta.sourcePoints, 500000); assert.ok(loaded.meta.activePoints <= 100000); assert.equal(loaded.error, 0);
    const qualities = [];
    for (const points of [25000, 250000, 100000]) {
      await page.locator('[data-point-budget]').selectOption(String(points));
      const state = await page.evaluate(() => ({ meta: window.__cdg.dbg.R.splat.getMetadata(), error: window.__cdg.dbg.R.gl.getError(), carMeshes: window.__cdg.W.car.root.children.length }));
      assert.equal(state.meta.activePoints, points); assert.equal(state.error, 0); assert.equal(state.carMeshes, loaded.carMeshes);
      qualities.push(state.meta);
    }
    await page.screenshot({ path: path.join(out, 'sample-lod-panel.png') });
    await page.locator('[data-sx]').click();
    await page.locator('[data-t="ask"]').click(); await page.locator('.npc-form input').fill('纯电动汽车有发动机吗？'); await page.locator('.npc-form button').click();
    await page.locator('.npc-line').waitFor();
    const answer = await page.locator('.npc-line').evaluate(el => { const text = el.cloneNode(true); text.querySelectorAll('rt').forEach(rt => rt.remove()); return text.textContent; });
    assert.match(answer, /没有发动机/);
    await page.locator('.modal [data-x]').click();
    // rAF observations here describe this browser/device only, not target-hardware acceptance.
    const frame = await page.evaluate(() => new Promise(resolve => {
      const times = []; let last = performance.now();
      function tick(now) { times.push(now-last); last=now; if(times.length < 50) requestAnimationFrame(tick); else { const valid=times.filter(t=>t>0&&t<1000).sort((a,b)=>a-b); resolve({samples:valid.length,medianMs:valid[Math.floor(valid.length/2)],p95Ms:valid[Math.floor(valid.length*.95)]}); } }
      requestAnimationFrame(tick);
    }));
    await page.locator('[data-t="scene"]').click(); await page.locator('[data-unload]').click();
    assert.equal(await page.evaluate(() => window.__cdg.dbg.MAR.loaded), false);
    assert.equal(await page.evaluate(() => window.__cdg.dbg.R.splat), null);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    const report = { sample: path.basename(sample), originalFactory: false, viewport: { width: 1440, height: 900 }, loadWallMs, loaded, qualities, frame, errors, externalRequests, qualityReversible: true, lessonNpcWorks: true, unloadWorks: true, targetIntegratedGpuAcceptance: false };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ loadWallMs, gpu: loaded.gpu, sourcePoints: loaded.meta.sourcePoints, qualities: qualities.map(x=>x.activePoints), frame, errors, externalRequests }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
