const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const out = path.resolve(process.env.WORKSHOP_BROWSER_ARTIFACT_DIR || 'artifacts/characters-browser');
const file = path.resolve('dist/插电工坊.html');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const report = { testedAt: new Date().toISOString(), buildSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    browser: browser.version(), realGeneratedModels: true, skeletalAnimation: false, viewports: [] };
  try {
    for (const [width, height] of [[1920,1080],[1366,768],[390,844]]) {
      const context = await browser.newContext({ viewport: { width, height }, offline: true });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
      await page.addInitScript(() => { window.CDG_AUTOSTATE = { level: 't', fast: true, station: 3, plug: true }; });
      await page.goto(pathToFileURL(file).href + '?debug=1');
      await page.waitForFunction(() => window.__cdg?.currentPrompt?.step === 'dragon-fix' && window.__cdg.characters.state.active === 'child', null, { timeout: 60000 });
      await page.evaluate(() => { window.__cdg.ST.sound = false; speechSynthesis.cancel(); });
      const initial = await page.evaluate(() => ({ step: __cdg.currentPrompt.step, responses: __cdg.ST.responses, position: [...__cdg.W.dragon.root.pos] }));
      const assets = [];
      for (const id of ['child', 'youth', 'child', 'youth']) {
        await page.locator('[data-t="character"]').click();
        await page.locator(`[data-character="${id}"]`).click();
        await page.waitForFunction(id => __cdg.characters.state.active === id && !__cdg.characters.state.loading, id);
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({ ...__cdg.characters.state, memory: { ...__cdg.dbg.R.info.memory }, render: { ...__cdg.dbg.R.info.render },
          glError: __cdg.dbg.R.gl.getError(), step: __cdg.currentPrompt.step, responses: __cdg.ST.responses, position: [...__cdg.W.dragon.root.pos] }));
        assert.equal(state.generated, true); assert.equal(state.error, null); assert.equal(state.glError, 0);
        assert.ok(state.stats.triangles > 1000); assert.ok(state.stats.textures > 0);
        assert.equal(state.step, initial.step); assert.equal(state.responses, initial.responses); assert.deepEqual(state.position, initial.position);
        const previous = assets.find(a => a.active === id);
        if (previous) assert.deepEqual(state.memory, previous.memory, 'switching must not leak GPU allocations');
        else await page.screenshot({ path: path.join(out, `${id}-teaching-${width}.png`) });
        assets.push(state);
      }
      await page.locator('#steps [data-i="4"]').click(); await page.waitForTimeout(1800);
      const actorBounds = await page.evaluate(() => {
        const { W, cam, dbg: { R } } = __cdg;
        function bounds(root) {
          const points = [];
          for (const n of R.items) {
            let parent = n; while (parent && parent !== root) parent = parent.parent;
            if (!parent) continue;
            for (const x of [n.mesh.min[0], n.mesh.max[0]]) for (const y of [n.mesh.min[1], n.mesh.max[1]]) for (const z of [n.mesh.min[2], n.mesh.max[2]]) {
              const point = cam.project(n.worldPos([x,y,z]), innerWidth, innerHeight); if (point) points.push(point);
            }
          }
          return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
        }
        return { wang: bounds(W.wang.root), dragon: bounds(W.dragon.root) };
      });
      if (width >= 1280) assert.ok(actorBounds.wang.right < actorBounds.dragon.left, 'the two actors should remain separately visible at the car display');
      await page.screenshot({ path: path.join(out, `youth-three-cars-${width}.png`) });
      // A device rejection must preserve the current actor, report failure and keep rendering.
      const failure = await page.evaluate(async () => {
        const { characters, W, dbg: { R } } = __cdg;
        const actor = W.dragon.body, original = R.prepareModel;
        R.prepareModel = () => { throw new Error('test_device_rejection'); };
        try { await characters.select('child'); } catch (_) {} finally { R.prepareModel = original; }
        let draws = 0; const render = R.render;
        R.render = function (...args) { draws++; return render.apply(this, args); };
        await new Promise(resolve => setTimeout(resolve, 200)); R.render = render;
        return { active: characters.state.active, error: characters.state.error, sameActor: W.dragon.body === actor, draws };
      });
      assert.equal(failure.active, 'youth'); assert.equal(failure.sameActor, true); assert.ok(failure.draws > 0); assert.equal(failure.error, 'test_device_rejection');
      await page.locator('[data-t="character"]').click(); await page.locator('[data-character="child"]').click();
      await page.waitForFunction(() => __cdg.characters.state.active === 'child' && !__cdg.characters.state.error);
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
      report.viewports.push({ width, height, assets, actorBounds, failure, errors, externalRequests: requests.length });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, viewports: report.viewports.length, buildSha256: report.buildSha256 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
