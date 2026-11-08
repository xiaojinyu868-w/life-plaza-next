// Optional browser integration check. Requires Playwright and an installed Edge browser.
// Run after npm run build; start npm start separately. No paid providers are used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const base = process.env.WORKSHOP_TEST_URL || 'http://127.0.0.1:5198';
const browserChannel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
const output = path.resolve(process.env.WORKSHOP_BROWSER_ARTIFACT_DIR || 'artifacts/browser');
const portableOffline = process.argv.includes('--portable-offline');
const sourceFile = path.resolve('dist/插电工坊.html');
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceSha256 = hashFile(sourceFile);
let classroomFile = sourceFile, portableCopy = null;
if (portableOffline) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-portable-'));
  classroomFile = path.join(directory, '课堂 离线.html');
  fs.copyFileSync(sourceFile, classroomFile);
  assert.equal(hashFile(classroomFile), sourceSha256);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(classroomFile)]);
  portableCopy = { directory, filename: path.basename(classroomFile), sha256: sourceSha256, siblingFiles: fs.readdirSync(directory) };
}
fs.mkdirSync(output, { recursive: true });

async function completeLesson(browser, lesson, plugged) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: portableOffline });
  const page = await context.newPage();
  let offlineProbe = null;
  if (portableOffline) {
    // Reserved .invalid destination; offline emulation must reject before any DNS/HTTP.
    const probe = await context.newPage();
    probe.once('requestfailed', request => { offlineProbe = request.failure()?.errorText; });
    await assert.rejects(probe.goto('https://workshop-portable.invalid/offline-probe', { timeout: 5000 }), /ERR_INTERNET_DISCONNECTED/);
    assert.equal(offlineProbe, 'net::ERR_INTERNET_DISCONNECTED');
    await probe.close();
  }
  const errors = [], requests = [], otherLocalResources = [], steps = new Set(), stations = new Set();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', r => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
    if (r.url().startsWith('file:') && new URL(r.url()).pathname !== pathToFileURL(classroomFile).pathname) otherLocalResources.push(r.url());
  });
  await page.addInitScript(() => { window.CDG_AUTOSTATE = { level: 2, fast: true }; });
  const url = pathToFileURL(classroomFile);
  url.searchParams.set('lesson', lesson); url.searchParams.set('debug', '1');
  await page.goto(url.href);
  if (portableOffline) assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.waitForFunction(() => window.__cdg?.currentPrompt !== undefined);
  await page.evaluate(() => { window.__cdg.ST.sound = false; window.speechSynthesis?.cancel(); });
  const start = Date.now(); let wrongTested = false, lastStep = null;
  while (Date.now() - start < 180000) {
    const state = await page.evaluate(() => ({
      prompt: window.__cdg.currentPrompt, station: window.__cdg.ST.station,
      done: !!document.querySelector('.modal .stats'),
    }));
    if (state.station && !stations.has(state.station)) { stations.add(state.station); console.log(`${lesson}: ${state.station} (${Math.round((Date.now() - start) / 1000)}s)`); }
    if (errors.length) throw new Error(errors.join('\n'));
    if (state.done) break;
    const cfg = state.prompt;
    if (!cfg || cfg.step === lastStep) { await page.waitForTimeout(60); continue; }
    let answer = cfg.answer;
    if (cfg.plugAction) answer = (cfg.options || []).find(x => plugged ? x.includes('🔌') : x.startsWith('先不插'));
    if (!answer) answer = cfg.options?.[0];
    assert.ok(answer, `No accessible answer for ${cfg.step}`);
    if (!wrongTested && cfg.stage === '说' && !cfg.noInput) {
      await page.locator('#inp').fill('不是这个答案'); await page.locator('#form button[type="submit"]').click();
      assert.equal(await page.evaluate(() => window.__cdg.currentPrompt?.step), cfg.step, 'wrong answer must not advance');
      wrongTested = true;
    }
    if (cfg.noInput || cfg.plugAction) {
      await page.locator('#chips [data-chip]').filter({ hasText: answer }).first().click();
    } else {
      await page.locator('#inp').fill(answer); await page.locator('#form button[type="submit"]').click();
    }
    const after = await page.evaluate(() => window.__cdg.currentPrompt?.step);
    assert.notEqual(after, cfg.step, `Reference response rejected at ${cfg.step}: ${answer}`);
    steps.add(cfg.step); lastStep = cfg.step;
  }
  if (!await page.locator('.modal .stats').count()) {
    const detail = await page.evaluate(() => ({ prompt: window.__cdg.currentPrompt, station: window.__cdg.ST.station, task: document.getElementById('task').textContent, message: document.getElementById('msg').textContent, caption: document.getElementById('capLine').textContent }));
    await page.screenshot({ path: path.join(output, `${lesson}-incomplete.png`) });
    throw new Error(`${lesson} incomplete: ${JSON.stringify(detail)}`);
  }
  await page.locator('.modal .stats').waitFor({ timeout: 1000 });
  const stats = await page.evaluate(() => ({ spoken: window.__cdg.ST.spoken, responses: window.__cdg.ST.responses, evidence: window.__cdg.ST.ev.size, lesson: window.CDG_CURRENT_LESSON.id }));
  assert.equal(stats.spoken, 0, 'typing must not count as speech');
  if (lesson === 'nev-l5') assert.equal(stats.evidence, 0, 'authored lesson must not acquire corpus evidence');
  assert.deepEqual([...stations], ['intro', 'a', 'b', 'd', 'c', 'end']);
  assert.equal(requests.length, 0, 'file classroom must not send HTTP requests');
  assert.equal(otherLocalResources.length, 0, 'single HTML must not depend on sibling source files or assets');
  await page.screenshot({ path: path.join(output, `${lesson}-${plugged ? 'plugged' : 'unplugged'}-complete.png`) });
  const result = { lesson, plugged, stations: [...stations], checkedPrompts: steps.size, wrongAnswerRecovery: wrongTested, offlineHttpRequests: requests.length, otherLocalResources: otherLocalResources.length, ...(portableOffline ? { navigatorOnline: await page.evaluate(() => navigator.onLine), offlineProbe } : {}), errors, ...stats };
  await context.close(); return result;
}

async function checkOnlineAndMobile(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?debug=1'); await page.locator('[data-lv="2"]').click();
  await page.locator('[data-t="sound"]').click();
  await page.locator('[data-t="online"]').click();
  await page.waitForFunction(() => document.querySelector('[data-t="online"]').textContent === '联机');
  await page.locator('[data-t="ask"]').click();
  await page.locator('.npc-form input').fill('纯电动汽车有发动机吗？');
  await page.locator('.npc-form button').click();
  await page.locator('.npc-line').waitFor();
  const answer = await page.locator('.npc-line').evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('rt').forEach(rt => rt.remove()); return copy.textContent; });
  assert.match(answer, /没有发动机/);
  assert.equal(await page.locator('.npc-answer .seal').count(), 0, 'NPC must not forge a corpus seal');
  await page.screenshot({ path: path.join(output, 'mobile-npc.png') });
  await page.locator('.npc-form input').fill('也放在哪里？');
  await page.locator('.npc-form button').click();
  await page.waitForFunction(() => {
    const copy = document.querySelector('.npc-line')?.cloneNode(true);
    copy?.querySelectorAll('rt').forEach(rt => rt.remove()); return copy?.textContent.includes('动词');
  });
  const vocabulary = await page.locator('.npc-line').evaluate(el => {
    const copy = el.cloneNode(true); copy.querySelectorAll('rt').forEach(rt => rt.remove());
    return { zh: copy.textContent, over: [...new Set([...el.querySelectorAll('ruby.ll-new')].map(x => x.dataset.w))], words: [...el.querySelectorAll('ruby')].map(x => x.dataset.w) };
  });
  const canonical = await import('../server/canonical.mjs');
  assert.deepEqual(vocabulary.over, canonical.overLevel(vocabulary.zh, 2, canonical.readLesson('nev-l4')).map(x => x.w));
  assert.ok(vocabulary.words.includes('前')); assert.ok(!vocabulary.over.includes('前'), 'official level1 word must not become unknown');
  await page.screenshot({ path: path.join(output, 'mobile-vocabulary.png') });
  await page.locator('.modal [data-x]').click();
  const cards = [];
  for (const [word, expected] of [['认', 'HSK 5级词汇'], ['识', 'HSK 6级词汇'], ['电', 'HSK 3 / 5级词汇'], ['燃油', 'HSK 7–9级词汇'], ['句子', 'HSK 3级词汇']]) {
    await page.evaluate(w => window.__cdg.openWord(w), word);
    const text = await page.locator('#card').innerText(); assert.ok(text.includes(expected), `${word}: ${expected}`);
    if (word === '电') assert.match(text, /需结合语境/);
    if (word === '句子') assert.match(text, /jùzi/);
    const rect = await page.locator('#card').boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
    cards.push({ word, expected, fitsViewport: true });
    if (word === '电' || word === '燃油') await page.screenshot({ path: path.join(output, `mobile-card-${word}.png`) });
    await page.locator('#card [data-close]').click();
  }
  await page.locator('[data-i="1"]').click(); await page.waitForTimeout(1800);
  const geometry = await page.evaluate(() => {
    const en = document.getElementById('capEn').getBoundingClientRect(), next = document.getElementById('capNext').getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, captionBottom: en.bottom, buttonTop: next.top };
  });
  assert.equal(geometry.width, geometry.scrollWidth);
  assert.ok(geometry.buttonTop >= geometry.captionBottom, 'continue must not cover translated caption');
  const marked = await page.locator('#capLine [data-w="插电式混合动力汽车"]').getAttribute('class');
  assert.match(marked, /ll-new/, 'professional vocabulary must remain visibly over level');
  await page.screenshot({ path: path.join(output, 'mobile-workshop.png') });
  await page.route('**/api/npc/turn', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await page.locator('[data-t="ask"]').click();
  await page.locator('.npc-form input').fill('纯电动汽车有发动机吗？'); await page.locator('.npc-form button').click();
  await page.locator('.npc-line').waitFor();
  const fallback = await page.locator('.npc-line').evaluate(el => { const copy = el.cloneNode(true); copy.querySelectorAll('rt').forEach(rt => rt.remove()); return copy.textContent; });
  assert.match(fallback, /没有发动机/);
  const teacher = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await teacher.goto(base + '/teacher.html'); await teacher.locator('#refresh').click();
  await teacher.locator('#results:not(.hidden)').waitFor();
  const metricCount = await teacher.locator('.metric').count(); assert.equal(metricCount, 5);
  const storageNotice = await teacher.locator('#storage').textContent(); assert.match(storageNotice, /最近 30 天/);
  await teacher.screenshot({ path: path.join(output, 'teacher-summary.png') });
  await teacher.close(); await page.close(); assert.deepEqual(errors, []);
  return { errors, connectedFallbackAnswer: answer, serviceFailureFallback: fallback, mobileGeometry: geometry, teacherMetrics: metricCount, storageNotice, vocabulary, cards };
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: browserChannel });
  try {
    const courses = [];
    const cases = [['nev-l5', true], ['nev-l4', false], ['nev-l4', true]];
    const selected = process.env.WORKSHOP_TEST_CASE;
    const selectedCases = selected ? cases.filter(([lesson, plugged]) => `${lesson}-${plugged ? 'plugged' : 'unplugged'}` === selected) : cases;
    assert.ok(selectedCases.length || selected === 'integration', 'Unknown WORKSHOP_TEST_CASE');
    for (const [lesson, plugged] of selectedCases) courses.push(await completeLesson(browser, lesson, plugged));
    assert.ok(!(portableOffline && selected === 'integration'), 'Portable offline mode only checks the copied file');
    const integration = !portableOffline && (!selected || selected === 'integration') ? await checkOnlineAndMobile(browser) : null;
    if (portableCopy) assert.deepEqual(fs.readdirSync(portableCopy.directory), [portableCopy.filename]);
    const result = { testedAt: new Date().toISOString(), browser: { channel: browserChannel, version: browser.version() }, mode: portableOffline ? 'portable-offline-browser-with-scripted-inputs' : 'real-browser-with-scripted-inputs', buildSha256: sourceSha256, portableCopy, realVoiceTested: false, realModelTested: false, courses, integration };
    fs.writeFileSync(path.join(output, portableOffline ? 'report-portable-offline.json' : selected ? `report-${selected}.json` : 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
