// Edge UI + real local service, synthetic microphone and injected mock ASR/LLM only.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
(async () => {
  const { createApp } = await import('../server/index.mjs');
  const { configuration } = await import('../server/services.mjs');
  const out = path.resolve('artifacts/npc-browser'); await fs.mkdir(out, { recursive:true });
  const providerCalls = [];
  const { server } = createApp({ config:{...configuration({}),dataDir:'.local/npc-browser-data',llmUrl:'https://mock.invalid/chat',llmKey:'synthetic-test',llmModel:'mock',asrUrl:'https://mock.invalid/asr',asrKey:'synthetic-test',asrModel:'mock'},
    fetchImpl:async (url,req) => {
      providerCalls.push(url.endsWith('/asr')?'asr':'llm');
      if(url.endsWith('/asr')) { assert.equal(req.body.get('refText'),null);assert.equal(req.body.get('prompt'),null);return new Response(JSON.stringify({text:'它有发动机吗？'})); }
      const request=JSON.parse(req.body),system=request.messages[0].content;
      const candidate=/本轮是课堂反馈/.test(system)?{intent:'answer',lookup:{kind:'feedback',style:'hint'},seal:false}
        :/新学徒小龙/.test(system)?{intent:'ask_back',zh:'为什么呀？师傅。',seal:false}
        :{intent:'answer',lookup:{kind:'fact',subject:/当前车辆bev/.test(system)?'bev':'phev',predicate:'engine'},seal:false};
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(candidate)}}],usage:{prompt_tokens:700,completion_tokens:40}}));
    } });
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({channel:'msedge',headless:true});const reports=[];
  try {
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
      const page=await browser.newPage({viewport}),errors=[],requests=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/npc/turn'))requests.push(r.postDataJSON());});
      await page.addInitScript(()=>{window.CDG_AUTOSTATE={level:2,station:1,fast:true};});
      await page.goto(url+'/?debug=1');await page.waitForFunction(()=>window.__cdg?.currentPrompt?.step==='recog-engine');
      await page.evaluate(()=>{window.__cdg.ST.sound=false;window.speechSynthesis?.cancel();window.npcCaptureStops=[];
        window.CDG_SPEECH.start=async()=>({stop(discard){window.npcCaptureStops.push(!!discard);return discard?null:new Blob(['synthetic audio'],{type:'audio/wav'});}});});
      await page.locator('[data-t="online"]').click();await page.waitForFunction(()=>document.querySelector('[data-t="online"]').textContent==='联机');
      const step=await page.evaluate(()=>window.__cdg.currentPrompt.step);
      for(let i=0;i<2;i++) {
        await page.locator('#inp').fill('动力电池');await page.locator('#form button[type="submit"]').click();
        await page.waitForFunction(count=>window.__cdg.ST.responses>=count&&document.querySelector('.npc-coaching'),i+1);
        await page.waitForFunction(n=>{const x=document.querySelector('.npc-coaching')?.cloneNode(true);if(!x)return false;x.querySelectorAll('rt').forEach(r=>r.remove());return x.textContent.includes(n===0?'先说':'请再读');},i);
        assert.equal(await page.evaluate(()=>window.__cdg.currentPrompt.step),step,'coaching must not pass the local task');
      }
      assert.equal(await page.locator('.npc-coaching .seal').count(),0);
      await page.screenshot({path:path.join(out,`coaching-${viewport.width}.png`)});
      await page.evaluate(()=>{window.__cdg.ST.focus='bev';});
      const before=await page.evaluate(()=>({step:window.__cdg.currentPrompt.step,responses:window.__cdg.ST.responses,spoken:window.__cdg.ST.spoken}));
      await page.locator('[data-t="ask"]').click();
      await page.locator('[data-npc-mic]').click();await page.locator('[data-npc-consent]').click();
      await page.waitForFunction(()=>document.querySelector('[data-npc-mic]').textContent==='停止录音');
      await page.locator('[data-npc-mic]').click();await page.waitForFunction(()=>document.querySelector('.npc-form input').value==='它有发动机吗？');
      assert.equal(requests.filter(r=>r.purpose!=='feedback').length,0,'recognition should wait for confirmation');
      await page.locator('.npc-form button').click();await page.locator('.npc-line').waitFor();
      const answer=await page.locator('.npc-line').evaluate(el=>{const x=el.cloneNode(true);x.querySelectorAll('rt').forEach(r=>r.remove());return x.textContent;});
      assert.match(answer,/没有发动机/);assert.equal(requests.at(-1).focus,'bev');
      assert.equal(await page.evaluate(()=>window.__cdg.currentPrompt.step),before.step);
      assert.equal(await page.evaluate(()=>window.__cdg.ST.responses),before.responses);
      assert.equal(await page.evaluate(()=>window.__cdg.ST.spoken),before.spoken+1);
      await page.evaluate(()=>window.__cdg.submit('发动机',false));
      assert.equal(await page.evaluate(()=>window.__cdg.currentPrompt.step),before.step,'modal blocks hidden classroom submit');
      await page.locator('.npc-role select').selectOption('dragon');await page.locator('.npc-form input').fill('请问我为什么');await page.locator('.npc-form button').click();await page.locator('.npc-line').waitFor();
      assert.equal(requests.at(-1).role,'dragon');assert.equal(await page.locator('.npc-answer .seal').count(),0);
      const geometry=await page.locator('.modal .box').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth};});
      assert.ok(geometry.left>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height);assert.equal(geometry.scrollWidth,geometry.width);
      await page.screenshot({path:path.join(out,`voice-question-${viewport.width}.png`)});
      await page.locator('[data-npc-mic]').click();await page.waitForFunction(()=>document.querySelector('[data-npc-mic]').textContent==='停止录音');
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.npcCaptureStops.at(-1)),true);
      assert.equal(await page.locator('.npc-form').count(),0);assert.deepEqual(errors,[]);
      reports.push({viewport,geometry,coachingTwoVariants:true,localVerdictPreserved:true,pronounCorrect:true,voiceQuestionConfirmed:true,partnerSelection:true,closeDiscardsAudio:true,errors,mockProviders:true});await page.close();
    }
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify({reports,providerCalls,realModelTested:false,realVoiceTested:false},null,2));console.log(JSON.stringify(reports,null,2));
  } finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
