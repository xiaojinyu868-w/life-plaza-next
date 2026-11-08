// Real browser UI/lifecycle checks with synthetic microphone and provider replies.
// This does NOT evaluate speech recognition accuracy or a real pronunciation vendor.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

(async () => {
  const { createApp } = await import('../server/index.mjs');
  const { configuration } = await import('../server/services.mjs');
  const dir = path.resolve('.local/speech-browser-data'), out = path.resolve('artifacts/speech-browser');
  await fs.mkdir(out, { recursive: true });
  const { server } = createApp({ config: { ...configuration({}), dataDir: dir } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const reports = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [], forms = [], events = []; let replyMode = 'tone', release;
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/status', route => route.fulfill({ json: { ok: true, capabilities: { assessment: true, asr: true }, privacy: { operatorName:'模拟课堂', events:{enabled:false,retentionDays:0}, speech:{providers:[{kind:'assessment',name:'模拟声调评测',region:'本机评测地域',audioRetention:'不代表真实服务条款',policyUrl:'https://example.test/assessment-policy'},{kind:'asr',name:'模拟文字识别',region:'本机识别地域',audioRetention:'测试说明',policyUrl:'https://example.test/asr-policy'}]} } } }));
      await page.route('**/api/learn/event', async route => { events.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
      await page.route('**/api/speech/assess', async route => {
        const body = route.request().postData();
        const field = name => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] || '';
        const target = field('refText'); forms.push({ target, mode: field('mode'), lesson: field('lesson') });
        if (replyMode === 'wait') await new Promise(resolve => { release = resolve; });
        if (replyMode === 'fail') { await route.fulfill({ status: 503, json: { ok: false } }); return; }
        const result = replyMode === 'asr' ? { ok: true, capability: 'L1', mode: 'read', transcript: target, transcriptSource: 'recognition', overall: null, words: [], seal: false }
          : { ok: true, capability: 'L2', mode: 'read', referenceText: target, transcript: target, transcriptSource: 'none', overall: 61, words: [{ w: target, chars: [{ c: [...target][0], tone: { valid: true, ref: 1, got: 4 } }] }], seal: false };
        await route.fulfill({ json: result }).catch(() => {});
      });
      await page.addInitScript(() => { window.CDG_AUTOSTATE = { level: 2, station: 1, fast: true }; });
      await page.goto(url + '/?debug=1');
      await page.waitForFunction(() => window.__cdg?.currentPrompt?.speechTarget);
      await page.evaluate(() => {
        window.__cdg.ST.sound = false; window.speechSynthesis?.cancel(); window.captureStops = [];
        window.CDG_SPEECH.start = async () => ({ stop(discard) { window.captureStops.push(!!discard); return discard ? null : new Blob([new Uint8Array(100)], { type: 'audio/wav' }); } });
      });
      const initial = await page.evaluate(() => ({ target: window.__cdg.currentPrompt.speechTarget, task: document.querySelector('#task').textContent, responses: window.__cdg.ST.responses }));
      await page.locator('[data-t="online"]').click();
      await page.waitForFunction(() => document.querySelector('[data-t="online"]').textContent === '联机');
      await page.locator('#mic').click();
      const notice = await page.locator('.voice-notice').textContent();
      for (const text of ['模拟声调评测','本机评测地域','模拟文字识别','本机识别地域','不新增保存匿名学习事件']) assert.ok(notice.includes(text));
      assert.equal(forms.length,0,'no audio before informed opt-in');
      await page.screenshot({path:path.join(out,`notice-${viewport.width}.png`)});
      await page.locator('[data-consent]').click();
      await page.waitForFunction(() => document.querySelector('#mic').textContent === '停止并发送');
      await page.locator('#mic').click(); await page.locator('.pronunciation [data-practice-record]').waitFor();
      assert.equal(await page.locator('[data-practice-submit]').count(), 0, 'reference text cannot become a submitted answer');
      assert.equal(await page.evaluate(() => window.__cdg.ST.spoken), 0);
      assert.equal(await page.evaluate(() => window.__cdg.ST.responses), initial.responses);
      assert.match(await page.locator('.practice-feedback').textContent(), /保持高音/);
      assert.equal(await page.locator('.pronunciation .seal').count(), 0);
      assert.ok(forms.every(x => x.lesson === 'nev-l4' && x.mode === 'read'));
      const geometry = await page.locator('.pronunciation .box').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, scrollWidth: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight }; });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height);
      assert.equal(geometry.scrollWidth, geometry.width);
      await page.screenshot({ path: path.join(out, `feedback-${viewport.width}.png`) });
      await page.locator('[data-practice-listen]').click();
      await page.waitForFunction(() => document.querySelector('[data-practice-status]').textContent.includes('没有播放成功'));
      await page.locator('[data-practice-drill="0"]').click();
      await page.locator('[data-practice-record]').click();
      await page.waitForFunction(() => document.querySelector('[data-practice-record]').textContent === '停止并发送');
      await page.locator('[data-practice-record]').click();
      await page.waitForFunction(() => document.querySelector('[data-practice-record]')?.textContent === '再读一次' && !document.querySelector('[data-practice-record]').disabled);
      assert.equal(forms[1].target, [...initial.target][0], 'retry must record selected drill, not the original full reference');
      assert.equal(await page.evaluate(() => window.__cdg.ST.spoken), 0);
      // A failed retry remains recoverable and leaves the underlying question untouched.
      replyMode = 'fail'; await page.locator('[data-practice-record]').click(); await page.locator('[data-practice-record]').click();
      await page.waitForFunction(() => document.querySelector('[data-practice-status]').textContent.includes('没有可靠结果'));
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.pronunciation').count(), 0);
      assert.equal(await page.locator('#task').textContent(), initial.task);
      replyMode = 'tone'; await page.locator('#mic').click(); await page.locator('#mic').click();
      await page.locator('[data-practice-record]').waitFor(); await page.locator('[data-practice-record]').click();
      await page.waitForFunction(() => document.querySelector('[data-practice-record]').textContent === '停止并发送');
      const beforeCancel = forms.length; await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.captureStops.at(-1)), true, 'closing feedback discards microphone audio');
      assert.equal(forms.length, beforeCancel, 'discarded recording is never uploaded');
      // Only a separately declared recognition transcript can be used for the actual answer.
      replyMode = 'asr'; await page.locator('#mic').click(); await page.locator('#mic').click();
      await page.locator('[data-practice-submit]').waitFor();
      assert.equal(await page.locator('.practice-score').count(), 0);
      await page.screenshot({ path: path.join(out, `asr-only-${viewport.width}.png`) });
      await page.locator('[data-practice-submit]').click();
      assert.equal(await page.evaluate(() => window.__cdg.ST.spoken), 1);
      // Stale result from the old station must never re-open the panel or change answers.
      await page.waitForFunction(() => window.__cdg.currentPrompt);
      replyMode = 'wait'; await page.locator('#mic').click(); await page.locator('#mic').click();
      await page.waitForTimeout(100); assert.equal(typeof release, 'function');
      await page.locator('[data-i="2"]').click();
      release(); await page.waitForTimeout(350);
      assert.equal(await page.locator('.pronunciation').count(), 0);
      assert.equal(await page.evaluate(() => window.__cdg.ST.spoken), 1);
      await page.waitForFunction(() => window.__cdg.currentPrompt);
      release = null; await page.locator('#mic').click(); await page.locator('#mic').click();
      await page.waitForTimeout(100); assert.equal(typeof release, 'function');
      await page.locator('[data-t="online"]').click(); release(); await page.waitForTimeout(250);
      assert.equal(await page.locator('.pronunciation').count(), 0);
      assert.equal(await page.locator('[data-t="online"]').textContent(), '离线');
      assert.equal(await page.evaluate(() => window.__cdg.ST.spoken), 1);
      assert.deepEqual(errors, []);
      reports.push({ viewport, geometry, requests: forms, errors, referenceAlignmentNotSubmitted: true, retryAndFailureRecovery: true, staleResultIgnored: true, closeDiscardsAudio: true, offlineDiscardsReply: true,
        pronunciationEvents: events.filter(e => e.type === 'pronunciation_attempt').length, syntheticMicrophoneAndReplies: true });
      await page.close();
    }
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports, null, 2));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
