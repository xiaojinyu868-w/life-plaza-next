// Verify the actual new handoff layout with learner input, not synthetic DOM geometry.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const out = path.resolve(process.env.WORKSHOP_BROWSER_ARTIFACT_DIR || 'artifacts/layout-refresh');
const file = path.resolve('dist/插电工坊.html');
const overlap = (a,b) => a && b && Math.min(a.right,b.right)-Math.max(a.left,b.left)>2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2;
async function rects(page) { return page.evaluate(()=>Object.fromEntries(['#cap','#inbar','.ll-fix','#topbar','#teacher','.toast'].map(s=>{const e=document.querySelector(s);if(!e||e.classList.contains('hidden')||getComputedStyle(e).display==='none')return[s,null];const r=e.getBoundingClientRect();return[s,{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}]}))); }
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
  const report={buildSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),viewports:[]};
  try {
    for(const [width,height] of [[1280,720],[1366,768],[1920,1080],[390,844]]) {
      const page=await browser.newPage({viewport:{width,height}}), errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{window.CDG_AUTOSTATE={level:'t',fast:true,station:3,plug:true};});
      await page.goto(pathToFileURL(file).href+'?debug=1');
      await page.waitForFunction(()=>window.__cdg?.currentPrompt?.step==='dragon-fix');
      await page.waitForFunction(()=>!window.__cdg.characters?.options.length || window.__cdg.characters.state.active===window.__cdg.characters.defaultId);
      assert.equal(await page.locator('#compare').isVisible(),false,'teacher entry is a complete class');
      await page.locator('#inp').fill('不是，也插电式混合动力汽车是新能源汽车。');
      await page.locator('#form button[type=submit]').click();
      await page.locator('.ll-fix').waitFor();await page.waitForTimeout(500);
      const boxes=await rects(page);
      for(const pair of [['#cap','#inbar'],['.ll-fix','#cap'],['.ll-fix','#inbar'],['#teacher','#topbar'],['#teacher','.toast']]) assert.ok(!overlap(boxes[pair[0]],boxes[pair[1]]),`${width}: ${pair.join(' overlaps ')}`);
      for(const id of ['#cap','#inbar','.ll-fix']) { const r=boxes[id];assert.ok(r && r.left>=-1 && r.right<=width+1 && r.top>=-1 && r.bottom<=height+1,`${width}: ${id} outside viewport`); }
      await page.screenshot({path:path.join(out,`correction-${width}.png`)});
      await page.locator('.ll-fix .ll-skip').click();
      await page.locator('#inp').fill('不是，插电式混合动力汽车也是新能源汽车。');
      await page.locator('#form button[type=submit]').click();
      await page.waitForFunction(()=>window.__cdg.currentPrompt?.step==='dragon-why');
      // Use the real station navigation, then inspect the settled three-car camera.
      await page.locator('#steps [data-i="4"]').click();await page.waitForTimeout(1700);
      const render=await page.evaluate(()=>({error:window.__cdg.dbg.R.gl.getError(),info:window.__cdg.dbg.R.info?.render,wang:window.__cdg.W.wang.root.pos,dragon:window.__cdg.W.dragon.root.pos}));
      assert.equal(render.error,0);assert.deepEqual(errors,[]);
      await page.screenshot({path:path.join(out,`three-cars-${width}.png`)});
      report.viewports.push({width,height,boxes,render,errors});await page.close();
    }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({viewports:report.viewports.length,buildSha256:report.buildSha256,passed:true}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
