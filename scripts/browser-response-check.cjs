// Real Edge + local HTTP service; controlled model delay and synthetic TTS lifecycle only.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

(async () => {
  const { createApp } = await import('../server/index.mjs');
  const { configuration } = await import('../server/services.mjs');
  const out = path.resolve('artifacts/response-browser'); await fs.mkdir(out,{recursive:true});
  let delayMs=30;
  const { server } = createApp({config:{...configuration({WORKSHOP_EVENT_RETENTION_DAYS:'0'}),llmUrl:'https://mock.invalid/chat',llmKey:'synthetic-test',llmModel:'mock'},fetchImpl:async(_url,req)=>{
    const request=JSON.parse(req.body),delay=delayMs;
    await new Promise(resolve=>setTimeout(resolve,delay));
    const candidate=request.messages[0].content.includes('本轮是课堂反馈')?{intent:'answer',lookup:{kind:'feedback',style:'hint'},seal:false}
      :{intent:'answer',lookup:{kind:'fact',subject:'bev',predicate:request.messages.at(-1).content.includes('驱动电机')?'motor':'engine'},seal:false};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(candidate)}}],usage:{prompt_tokens:50,completion_tokens:30}}));
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({channel:'msedge',headless:true}), reports=[];
  try {
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
      const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        window.CDG_AUTOSTATE={level:2,station:1,fast:true};
        window.syntheticTtsMode='normal';window.syntheticTts=[];let active=null;
        const fake={getVoices:()=>[{lang:'zh-CN',name:'Synthetic test voice',localService:true}],cancel(){if(active){active.cancelled=true;active=null;}},speak(utterance){
          const call={utterance,cancelled:false,text:utterance.text};active=call;window.syntheticTts.push(call);
          if(window.syntheticTtsMode==='stall')return;
          setTimeout(()=>{if(!call.cancelled)utterance.onstart?.();},20);
          setTimeout(()=>{if(!call.cancelled){utterance.onend?.();if(active===call)active=null;}},500);
        }};
        Object.defineProperty(window,'speechSynthesis',{configurable:true,value:fake});
        Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text;}}});
        Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:class{start(){this.onstart?.();}stop(){this.onend?.();}abort(){this.onend?.();}}});
      });
      await page.goto(url+'/?debug=1');await page.waitForFunction(()=>window.__cdg?.currentPrompt?.step==='recog-engine');
      await page.evaluate(()=>{window.__cdg.ST.focus='bev';window.__cdg.npcTiming.clear();});
      await page.locator('[data-t="online"]').click();await page.waitForFunction(()=>document.querySelector('[data-t="online"]').textContent==='联机');
      await page.locator('[data-t="ask"]').click();
      const ask=async text=>{await page.locator('.npc-form input').fill(text);await page.locator('.npc-form button').click();};
      const latest=()=>page.evaluate(()=>window.__cdg.npcTiming.snapshot().at(-1));
      const rendered=()=>page.waitForFunction(()=>window.__cdg.npcTiming.snapshot().at(-1)?.status==='rendered');

      delayMs=30;await ask('纯电动汽车有发动机吗？');await rendered();
      let fast=await latest();assert.equal(fast.cueRequestedMs,null);assert.equal(fast.modelFirstTokenMs,null);assert.equal(fast.source,'llm');
      delayMs=1600;await ask('纯电动汽车有驱动电机吗？');await page.locator('.npc-waiting').waitFor();
      await page.waitForFunction(()=>window.__cdg.npcTiming.snapshot().at(-1)?.cueSpeechStartMs!==null);
      assert.equal(await page.locator('.npc-waiting .seal').count(),0);assert.ok(await page.locator('.npc-waiting .ll-new').count()>0);
      assert.ok(!(await page.locator('.npc-waiting').textContent()).includes('meaning not yet checked'));
      assert.match(await page.locator('.npc-waiting ruby[data-w="想"] rt').first().textContent(),/xiǎng/);
      await page.screenshot({path:path.join(out,`waiting-${viewport.width}.png`)});await rendered();
      const slow=await latest();assert.ok(slow.cueSpeechStartMs>=900&&slow.cueSpeechStartMs<1500);assert.ok(slow.answerFrameMs>1500&&slow.answerFrameMs<3000);assert.equal(slow.modelFirstTokenMs,null);
      assert.equal(await page.locator('.npc-waiting').count(),0);assert.match(await page.locator('.npc-line').textContent(),/有/);

      // No onstart means no audible-reaction success, even though the text answer is painted.
      await page.evaluate(()=>{window.syntheticTtsMode='stall';});delayMs=2250;
      await ask('纯电动汽车有发动机吗？');await rendered();
      let stalled=await latest();assert.equal(stalled.cueSpeechStartMs,null);assert.equal(stalled.cueSpeechResult,'start_timeout');
      await page.waitForFunction(()=>window.__cdg.npcTiming.snapshot().at(-1)?.answerSpeechResult==='start_timeout');
      stalled=await latest();assert.equal(stalled.answerSpeechStartMs,null);assert.equal(stalled.modelFirstTokenMs,null);

      // Closing before the cue cancels it; the later answer cannot write to a new dialog.
      await page.evaluate(()=>{window.syntheticTtsMode='normal';});delayMs=1600;
      await ask('纯电动汽车有发动机吗？');await page.keyboard.press('Escape');
      const cancelled=await latest();assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cancelReason,'dialog_closed');
      await page.locator('[data-t="ask"]').click();delayMs=30;await ask('纯电动汽车有驱动电机吗？');await rendered();
      await page.waitForTimeout(1700);assert.match(await page.locator('.npc-line').textContent(),/驱/);assert.equal(await page.locator('.npc-waiting').count(),0);

      // Starting voice input during a pending answer must release the submit button.
      delayMs=1600;await ask('纯电动汽车有发动机吗？');await page.locator('[data-npc-mic]').click();await page.locator('[data-npc-consent]').click();
      await page.waitForFunction(()=>document.querySelector('[data-npc-mic]').textContent==='停止录音');
      assert.equal(await page.locator('.npc-form button').isEnabled(),true);
      assert.equal((await latest()).cancelReason,'recording');
      delayMs=30;await ask('纯电动汽车有驱动电机吗？');await rendered();
      await page.waitForTimeout(1700);assert.match(await page.locator('.npc-line').textContent(),/驱/);

      // A wrong answer keeps the local correction and cannot pass while coaching is pending.
      await page.keyboard.press('Escape');delayMs=1600;
      const step=await page.evaluate(()=>window.__cdg.currentPrompt.step);
      await page.locator('#inp').fill('动力电池');await page.locator('#form button[type="submit"]').click();
      const localHint=await page.locator('#msg').textContent();await page.locator('#hintline .npc-waiting').waitFor();
      assert.equal(await page.locator('#msg').textContent(),localHint);await rendered();
      assert.equal(await page.evaluate(()=>window.__cdg.currentPrompt.step),step);assert.equal(await page.locator('#hintline .npc-waiting').count(),0);
      const coaching=await latest();assert.equal(coaching.kind,'feedback');
      const rows=await page.evaluate(()=>window.__cdg.npcTiming.snapshot());
      assert.ok(!JSON.stringify(rows).includes('纯电动'));assert.deepEqual(errors,[]);
      reports.push({viewport,fast,slow,stalled,cancelled,coaching,errors,realModelTested:false,realTtsAudioTested:false});await page.close();
    }
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify({scope:'browser-submission-to-render-opportunity; synthetic TTS lifecycle',reports},null,2));
    console.log(JSON.stringify(reports.map(r=>({viewport:r.viewport,fastFrameMs:r.fast.answerFrameMs,slowCueStartMs:r.slow.cueSpeechStartMs,slowFrameMs:r.slow.answerFrameMs,stallReported:r.stalled.answerSpeechResult,closeIgnoredLateReply:true,recordingInterruptResetsForm:true,localCoachingPreserved:true,errors:r.errors,realModelTested:false,realTtsAudioTested:false})),null,2));
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
