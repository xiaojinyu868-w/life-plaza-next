// Reproducible, silent recording of existing local materials and a real fixed build.
// node scripts/record-production.cjs [--preview|--check-inputs] [--expected-sha SHA256]
// No credentials, remote API calls, user-supplied commands, or course generation.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'production-demo');
const OUTPUT = path.join(ROOT, 'dist', '插电工坊.html');
const args = process.argv.slice(2), preview = args.includes('--preview');
const expectedAt = args.indexOf('--expected-sha');
const expectedSha = expectedAt >= 0 ? args[expectedAt + 1] : null;
if (expectedSha && !/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error('Invalid expected SHA256');
const read = file => fs.readFileSync(path.join(ROOT, file));
const json = file => JSON.parse(read(file));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(ROOT, file).split(path.sep).join('/');
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lessonFile = 'content/lessons/nev-l4.json', lesson = json(lessonFile);
require('../src/lesson.js').validate(lesson);
const catalog = json('content/characters.json');
const characters = ['child', 'youth'].map(id => {
  const asset = catalog.characters.find(a => a.id === id && a.status === 'verified');
  assert.ok(asset, 'Missing adopted character');
  const file = path.resolve(ROOT, asset.model), modelsRoot = path.join(ROOT, 'assets', 'models') + path.sep;
  assert.ok(file.startsWith(modelsRoot) && file.endsWith('.glb'));
  const bytes = fs.readFileSync(file), generationFile = path.join(path.dirname(file), 'generation.json');
  const generation = JSON.parse(fs.readFileSync(generationFile));
  assert.equal(sha(bytes), asset.sha256);
  assert.equal(generation.taskId, asset.taskId);
  assert.equal(generation.status, 'success');
  assert.equal(generation.review, 'accepted-for-classroom');
  return { id, name: asset.name, height: asset.height, taskId: asset.taskId, sha256: asset.sha256,
    model: relative(file), file, bytes: bytes.length, generationFile: relative(generationFile),
    generationSha256: sha(fs.readFileSync(generationFile)), credits: generation.creditsConsumed,
    modelVersion: generation.options.model, skeletalAnimation: generation.skeletalAnimation };
});
const rejectedFile = 'assets/models/rejected-generations.json';
const rejectedMetadata = json(rejectedFile);
assert.equal(rejectedMetadata.schemaVersion, 1);
const rejected = rejectedMetadata.generations.find(generation => generation.taskId === 'da1b5690-05d5-47ab-a61b-e64d93bd64f8');
assert.ok(rejected, 'Missing verified rejected generation metadata');
assert.equal(rejected.review, 'rejected-missing-antlers');
const credits = characters.reduce((sum, asset) => sum + asset.credits, rejected.creditsConsumed);
assert.equal(credits, 180);
// Only normative textbook/video channels. Learner-error examples are intentionally not in this view.
const evidence = Object.entries(lesson.evidence).filter(([, e]) => [0, 1].includes(e.ch)).map(([id, e]) => ({ id, ...e }));
const data = { title: lesson.title, vocabulary: lesson.vocabulary, grammar: lesson.grammar,
  stations: lesson.stations.map(station => ({ id: station.id, name: station.name,
    commandCount: station.commands.length, line: station.commands.find(command => command.op === 'say')?.line?.zh || '' })),
  evidence, characters: characters.map(({ file, ...asset }) => asset),
  rejected: { taskId: rejected.taskId, credits: rejected.creditsConsumed }, credits };
const serialized = JSON.stringify(data).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>插电工坊 · 制作过程</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#152630;font-family:"Microsoft YaHei",system-ui,sans-serif}main{width:1296px;margin:32px auto}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:32px;margin:0 0 9px}header p{font-size:18px;color:#62707a;margin:0}.local{background:#e8f3ef;color:#23664f;padding:10px 16px;border-radius:8px;font-size:16px}nav{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:27px 0 22px}button{cursor:pointer;font:inherit}nav button{border:1px solid #d5dee2;background:white;color:#63737c;text-align:left;padding:15px 20px;border-radius:10px;font-size:20px}nav button.active{border-color:#168364;color:#08694f;box-shadow:inset 0 0 0 1px #168364}nav b{margin-right:14px}section{display:none;background:#fff;border:1px solid #dce3e7;border-radius:15px;padding:26px 30px;height:650px}section.active{display:block}h2{font-size:25px;margin:0 0 9px}p{line-height:1.65}.muted{color:#64737c;font-size:17px;margin:6px 0 20px}.columns{display:grid;grid-template-columns:1fr 1.12fr;gap:35px}.words{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.word{padding:10px 16px;border-radius:8px;background:#eef6f3;color:#1a5e4b;font-size:24px}.grammar{margin-top:28px;padding:20px;background:#f5f6f8;border-radius:10px;font-size:22px}.grammar small{display:block;font-size:15px;color:#6a767e;margin-bottom:8px}.stations{padding:0;margin:10px 0;list-style:none}.stations li{margin-bottom:10px;border-bottom:1px solid #e7ecee;padding:4px 0 11px;font-size:20px}.stations li small{display:block;color:#63717c;font-size:16px;margin-top:5px}.number{color:#118061;font-weight:700;margin-right:13px}.source{font-size:15px;color:#67747c;line-height:1.7}.search{display:flex;gap:12px;align-items:center;margin:22px 0}.search input{border:1px solid #9badb6;padding:12px 17px;border-radius:8px;width:300px;font:24px inherit}.primary{border:0;background:#08765b;color:#fff;padding:13px 23px;border-radius:8px;font-size:19px}.primary:disabled{background:#91aaa3;cursor:default}.notice{font-size:17px;background:#fff6e8;color:#76501c;border:1px solid #edd9b6;border-radius:8px;padding:12px 17px}.hits{display:grid;gap:15px;margin-top:18px}.hit{background:#f6f8f9;border-radius:10px;padding:18px 21px}.hit blockquote{font-size:24px;line-height:1.6;margin:0 0 13px}.hit mark{background:#d7eee4;color:inherit}.hit .meta{font-size:16px;line-height:1.7;color:#5b6972}.models{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:13px}.modelcard{border:1px solid #e0e7e9;border-radius:10px;overflow:hidden;position:relative}.modelcard canvas{display:block;width:588px;height:330px;background:#eff2f4}.modelinfo{padding:13px 16px}.modelinfo h3{margin:0 0 7px;font-size:22px}.mono{font-family:Consolas,monospace;font-size:15px;overflow-wrap:anywhere}.modelinfo p{margin:3px 0;font-size:15px;color:#5c6e77}.cost{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:15px 17px;background:#f6f8f9;border-radius:9px}.cost strong{font-size:23px;color:#126d54}.cost span{font-size:17px}.buildarea{padding-top:16px}.buildarea pre{font:17px/1.8 Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;background:#f3f6f7;border:1px solid #e0e7e9;padding:20px;border-radius:10px;min-height:107px}.buildfacts{display:grid;grid-template-columns:1fr 2fr;gap:16px;margin:20px 0}.buildfacts div{background:#f1f7f4;padding:18px;border-radius:9px}.buildfacts strong{display:block;color:#126d54;font-size:24px;margin-top:10px}.buildfacts small{display:block;color:#63727a;font-size:15px}.hash{line-height:1.8;word-break:break-all;font-family:Consolas,monospace;font-size:17px!important}footer{display:flex;justify-content:space-between;color:#6d7b82;font-size:14px;padding:15px 2px}.status{font-size:17px;color:#126d54;margin-left:18px}#buildresult[hidden]{display:none}
main{margin:20px auto}nav{margin:20px 0 18px}section{height:638px;padding:23px 30px}.stations li{margin-bottom:4px;padding:3px 0 8px;font-size:19px}.stations li small{font-size:15px;line-height:1.3;margin-top:3px}.search input{font-family:inherit;font-size:24px}#step3 .muted{font-size:16px;margin:5px 0 10px}.modelcard canvas{height:270px;width:100%}.modelinfo{padding:10px 16px}.modelinfo h3{font-size:21px}.models{margin-top:10px}.cost{margin-top:12px;padding:12px 17px}#step3 .source{margin:10px 0 0;font-size:15px;line-height:1.55}
</style><main><header><div><h1>插电工坊 · 制作过程</h1><p>查看已有课程与真实素材，再构建可离线打开的课堂</p></div><span class="local">本地操作演示 · 无音轨</span></header>
<nav><button data-step="1" class="active"><b>01</b>课程内容</button><button data-step="2"><b>02</b>语料快照</button><button data-step="3"><b>03</b>小龙模型</button><button data-step="4"><b>04</b>构建课堂</button></nav>
<section id="step1" class="active"><div class="columns"><div><h2>第 4 课 · ${esc(lesson.title)}</h2><p class="muted">从已编写的课程包读取 ${lesson.vocabulary.length} 个目标词与 ${lesson.grammar.length} 个语法点</p><div class="words">${lesson.vocabulary.map(word=>`<span class="word">${esc(word)}</span>`).join('')}</div><div class="grammar"><small>本课语法</small>${lesson.grammar.map(esc).join('　／　')}</div><p class="source">实际文件：content/lessons/nev-l4.json<br>人工编写的课程流程；本片不演示自动教材上传或自动生成整课。</p></div><div><h2>实际课程步骤</h2><p class="muted">按课程包中的顺序读取，包含场景动作、引导与练习</p><ol class="stations">${data.stations.map((s,i)=>`<li><span class="number">${i+1}</span>${esc(s.name)}<small>${esc(s.line)}<br>${s.commandCount} 条顶层指令 · 站点 ${esc(s.id)}</small></li>`).join('')}</ol></div></div></section>
<section id="step2"><h2>查“也”：先检查已保存的语料证据</h2><p class="muted">筛选范围：本课 evidence 中的教材与教学视频快照；按原句文本进行本地匹配。</p><div class="notice">离线快照，非实时回源。下列检索式、命中数和采集时间来自既有快照；本次没有调用语料 API。</div><form class="search" id="searchform"><input id="query" aria-label="本地原句过滤词" placeholder="输入原句中的词"><button class="primary" type="submit">过滤本地快照</button><span class="status" id="filterstatus">等待输入</span></form><div id="hits" class="hits"></div></section>
<section id="step3"><h2>两款已采用的真实 3D 资产</h2><p class="muted">现有课堂 WebGL 引擎直接读取 runtime GLB；保留原模型与贴图。当前为静态姿态，无骨骼动画。</p><div class="models">${characters.map(a=>`<div class="modelcard"><canvas id="model-${a.id}" aria-label="${esc(a.name)}"></canvas><div class="modelinfo"><h3>${esc(a.name)}</h3><p class="mono">任务 ${esc(a.taskId)}</p><p>${a.credits} 积分 · ${esc(a.modelVersion)} · 采用 / verified</p><p id="modelstats-${a.id}">等待读取本地 GLB</p></div></div>`).join('')}</div><div class="cost"><strong>本次角色生成合计 ${credits} 积分</strong><span>幼年 60 + 青年首版 60 + 青年重生成 60</span></div><p class="source">青年首版缺少参考图中的鹿角，已弃用并重生成；右侧为已复核采用的版本。<br>本片只读取已有文件，不重新提交生成任务、不产生新费用。</p></section>
<section id="step4"><h2>执行本地构建，打开生成的课堂</h2><p class="muted">点击后由录制工具执行固定的 Node build.js；以下结果来自真实子进程与输出文件。</p><div class="buildarea"><button id="build" class="primary">运行 build.js</button><span id="buildstatus" class="status">尚未执行</span><pre id="stdout">构建 stdout 将显示在这里。</pre><div id="buildresult" hidden><div class="buildfacts"><div><small>实际输出 / dist/插电工坊.html</small><strong id="buildsize"></strong><p id="buildexit"></p></div><div><small>生成 HTML 的 SHA-256</small><strong id="buildhash" class="hash"></strong></div></div><p class="notice">这个 HTML 内嵌既有课程和角色模型，可离线打开。构建不等于自动生成教学内容。</p><button id="openclass" class="primary">打开刚生成的课堂入口 →</button></div></div></section>
<footer><span>真实文件 · 真实过滤 · 真实构建</span><span>脚本辅助操作录像 ｜ 不含实时语料回源与自动生课</span></footer></main>
<script src="/engine.js"></script><script src="/model.js"></script><script>
'use strict';const DATA=${serialized};const $=id=>document.getElementById(id);window.production={filter:null,models:[],build:null};
const escapeHTML=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let modelsPromise=null,viewers=[];function draw(){if($('step3').classList.contains('active'))for(const v of viewers)v.renderer.render(v.root,v.camera);requestAnimationFrame(draw)}requestAnimationFrame(draw);
async function loadModels(){for(const a of DATA.characters){const response=await fetch('/model-'+a.id+'.glb');if(!response.ok)throw Error('Local GLB unavailable');const model=await CDG_MODEL.loadGLB(await response.arrayBuffer());const root=CDG_MODEL.normalize(model,{height:a.height});const renderer=new E.Renderer($('model-'+a.id)),camera=new E.Camera();renderer.env.clear=[.95,.96,.97];renderer.env.fogN=100;renderer.env.fogF=200;camera.target=[0,a.height*.49,0];camera.pitch=.08;camera.dist=a.height*2.3;camera.fov=.62;camera.yaw=Math.PI/2;const uploaded=renderer.prepareModel(model);renderer.render(root,camera);const error=renderer.gl.getError();if(error)throw Error('GL error '+error);viewers.push({model,root,renderer,camera});window.production.models.push({id:a.id,stats:model.stats,uploaded,glError:error,cameraYaw:camera.yaw});$('modelstats-'+a.id).textContent=model.stats.triangles.toLocaleString()+' 个三角形 · '+model.stats.textures+' 张真实贴图 · GPU 已上传'}return window.production.models}
document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('nav button,section').forEach(el=>el.classList.remove('active'));button.classList.add('active');$('step'+button.dataset.step).classList.add('active');if(button.dataset.step==='3'&&!modelsPromise){modelsPromise=loadModels();modelsPromise.catch(e=>{window.production.modelError=e.message})}}));
$('searchform').addEventListener('submit',event=>{event.preventDefault();const q=$('query').value.trim();const matches=q?DATA.evidence.filter(e=>e.zh.includes(q)):[];window.production.filter={query:q,source:'lesson.evidence',channels:[0,1],field:'zh',ids:matches.map(e=>e.id),count:matches.length,realRemoteCorpusQuery:false};$('filterstatus').textContent='本地匹配 '+matches.length+' 条';$('hits').innerHTML=matches.map(e=>'<article class="hit"><blockquote>'+escapeHTML(e.zh).split(escapeHTML(q)).join('<mark>'+escapeHTML(q)+'</mark>')+'</blockquote><div class="meta">来源：'+escapeHTML(e.src)+'<br>原检索式：'+escapeHTML(e.q)+'　｜　原命中数：'+e.hits+'　｜　快照时间：'+escapeHTML(e.at)+'</div></article>').join('')});
$('build').addEventListener('click',async()=>{$('build').disabled=true;$('buildstatus').textContent='正在执行真实本地构建…';try{const result=await window.buildClassroom();window.production.build=result;$('stdout').textContent=result.stdout;$('buildstatus').textContent='已完成 · 返回码 '+result.exitCode;$('buildsize').textContent=(result.bytes/1024/1024).toFixed(2)+' MiB';$('buildexit').textContent=result.bytes.toLocaleString()+' bytes · exit '+result.exitCode;$('buildhash').textContent=result.sha256;$('buildresult').hidden=false}catch(error){$('buildstatus').textContent='构建失败';$('stdout').textContent=error.message;window.production.buildError=error.message}});
$('openclass').addEventListener('click',()=>{for(const v of viewers){v.model.dispose(v.renderer);v.renderer.dispose()}location.href='/classroom?lesson=nev-l4&character=youth&debug=1'});
</script></html>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const report = { recordingMode: 'scripted-text-and-real-local-build', realRemoteCorpusQuery: false,
    autoCourseGeneration: false, silent: true, viewport: { width: 1440, height: 900 }, startedAt,
    preview, source: { lesson: lessonFile, lessonSha256: sha(read(lessonFile)), characters: data.characters,
      rejectedYouth: { taskId: rejected.taskId, review: rejected.review, credits: rejected.creditsConsumed, metadataFile: rejectedFile, metadataSha256: sha(read(rejectedFile)) }, totalCredits: credits },
    milestones: [], errors: [], blockedExternalRequests: [], localRequests: [] };
  const routes = new Map([['/engine.js', ['text/javascript', path.join(ROOT, 'src/engine.js')]],
    ['/model.js', ['text/javascript', path.join(ROOT, 'src/model.js')]],
    ['/classroom', ['text/html; charset=utf-8', OUTPUT]],
    ...characters.map(a=>['/model-'+a.id+'.glb',['model/gltf-binary',a.file]])]);
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (route === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (route === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html); return; }
    const allowed = routes.get(route);
    if (!allowed) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type':allowed[0],'Cache-Control':'no-store'});
    fs.createReadStream(allowed[1]).on('error',()=>res.destroy()).pipe(res);
  });
  let browser, context;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge',headless:true});
    report.browser = browser.version();
    context = await browser.newContext({viewport:report.viewport,deviceScaleFactor:1,serviceWorkers:'block',
      ...(!preview?{recordVideo:{dir:path.join(OUT,'raw'),size:report.viewport}}:{})});
    await context.route('**/*',route=>{
      const url=route.request().url();
      if (/^https?:/.test(url) && new URL(url).origin !== origin) {report.blockedExternalRequests.push(url);return route.abort('blockedbyclient')}
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('request',request=>{if(request.url().startsWith(origin))report.localRequests.push(new URL(request.url()).pathname)});
    let buildPromise;
    await page.exposeFunction('buildClassroom',()=>{
      if (buildPromise) return buildPromise;
      buildPromise=(async()=>{
        const beforeSha = sha(fs.readFileSync(OUTPUT)), buildStartedAt=new Date().toISOString();
        const {stdout,stderr}=await run(process.execPath,[path.join(ROOT,'build.js')],{cwd:ROOT,windowsHide:true,timeout:60000,maxBuffer:1024*1024});
        const bytes=fs.readFileSync(OUTPUT), outputSha=sha(bytes);
        const sanitize=text=>text.split(ROOT).join('.').replace(/\\/g,'/').trim();
        report.build={command:'node build.js',startedAt:buildStartedAt,finishedAt:new Date().toISOString(),exitCode:0,
          stdout:sanitize(stdout),stderr:sanitize(stderr),output:'dist/插电工坊.html',bytes:bytes.length,sha256:outputSha,
          previousSha256:beforeSha,expectedSha256:expectedSha||beforeSha,reproducedSameHash:outputSha===(expectedSha||beforeSha)};
        assert.equal(outputSha,expectedSha||beforeSha,'Build changed expected classroom SHA256');
        return report.build;
      })();return buildPromise;
    });
    const mark=async(name)=>{const file=name+'.png';await page.screenshot({path:path.join(OUT,file)});report.milestones.push({name,at:new Date().toISOString(),screenshot:relative(path.join(OUT,file))});console.log('Verified '+name)};
    const hold=ms=>page.waitForTimeout(preview?150:ms);
    await page.goto(origin,{waitUntil:'networkidle'});
    await mark('01-course');await hold(10500);
    await page.locator('[data-step="2"]').click();await hold(1000);
    await page.locator('#query').pressSequentially('也',{delay:300});await hold(600);
    await page.locator('#searchform button').click();
    report.filter=await page.evaluate(()=>window.production.filter);
    assert.equal(report.filter.count,2);assert.deepEqual(report.filter.ids,['tb-l4-p45','vd-ye']);
    await mark('02-corpus');await hold(11000);
    await page.locator('[data-step="3"]').click();
    await page.waitForFunction(()=>window.production.models.length===2||window.production.modelError,{},{timeout:30000});
    const models=await page.evaluate(()=>({models:window.production.models,error:window.production.modelError}));
    assert.equal(models.error,undefined);assert.equal(models.models.length,2);report.models=models.models;
    await mark('03-models');await hold(15500);
    if(!preview){
      await page.locator('[data-step="4"]').click();await hold(1500);
      await page.locator('#build').click();
      await page.waitForFunction(()=>window.production.build||window.production.buildError,{},{timeout:70000});
      assert.equal(await page.evaluate(()=>window.production.buildError),undefined);
      await mark('04-built');await hold(11500);
      await page.locator('#openclass').click();
      await page.waitForFunction(()=>window.__cdg?.characters?.state.active==='youth'&&!window.__cdg.characters.state.loading,{},{timeout:30000});
      await page.locator('#gate').waitFor({state:'visible'});
      report.classroom=await page.evaluate(()=>({title:document.title,activeCharacter:window.__cdg.characters.state.active,
        gateVisible:!document.getElementById('gate').classList.contains('hidden'),lesson:window.CDG_CURRENT_LESSON.id,
        renderedTriangles:window.__cdg.dbg.R.info.render.triangles}));
      assert.ok(report.classroom.renderedTriangles>0);await mark('05-classroom');await hold(7500);
    }
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedExternalRequests,[]);
    const video=page.video();await context.close();context=null;
    if(video){const videoFile=path.join(OUT,'production-process.webm');await video.saveAs(videoFile);await video.delete();
      report.video={file:relative(videoFile),bytes:fs.statSync(videoFile).size,sha256:sha(fs.readFileSync(videoFile))};
      const {stdout}=await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',videoFile],{windowsHide:true,maxBuffer:1024*1024});
      const probe=JSON.parse(stdout),visual=probe.streams.find(s=>s.codec_type==='video');
      Object.assign(report.video,{durationSeconds:Number(probe.format.duration),width:visual.width,height:visual.height,
        videoCodec:visual.codec_name,audioStreams:probe.streams.filter(s=>s.codec_type==='audio').length});
      assert.equal(report.video.audioStreams,0);assert.equal(visual.width,1440);assert.equal(visual.height,900);
      assert.ok(report.video.durationSeconds>=45&&report.video.durationSeconds<=75,'Recording outside 45–75 seconds');
    }
    report.finishedAt=new Date().toISOString();report.passed=true;
  } catch(error){report.passed=false;report.failure=error.message;throw error}
  finally{
    if(context)await context.close().catch(()=>{});
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
    report.processesStopped=true;report.closedAt=new Date().toISOString();
    fs.writeFileSync(path.join(OUT,preview?'preview-report.json':'report.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({passed:report.passed,video:report.video,buildSha256:report.build?.sha256,processesStopped:report.processesStopped}));
}
if(args.includes('--check-inputs')) console.log(JSON.stringify({passed:true,lesson:lesson.id,characters:characters.map(a=>a.id),credits,rejectedMetadata:rejectedFile}));
else main().catch(error=>{console.error(error.message);process.exitCode=1});
