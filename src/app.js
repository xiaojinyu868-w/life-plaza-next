/* 插电工坊 · 课堂流程与学习层 */
(function () {
  'use strict';
  const D = window.CDG_DATA, S = window.CDG_SCRIPT, L = window.CDG_LOGIC, H = window.CDG_HSK, WD = window.CDG_WORLD, E = window.E;
  const { V3, hex } = E;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const CJK = /[㐀-鿿]/;

  const ST = { level: 2, plugged: false, compare: false, teacher: false, py: true, en: true, sound: true, spoken: 0, responses: 0, selfReported: 0, hints: 0, ev: new Set(), station: null, done: new Set(), focus: 'phev', everPlugged: false };
  const AUTO = window.CDG_AUTOSTATE || null; // 测试用：直接跳到某一步
  const LESSON = window.CDG_CURRENT_LESSON;
  const LEXICON = window.CDG_LEXICON.create(window.CDG_HSK_VOCAB);
  const lexiconOptions = { dictionary: LESSON?.dict || D.DICT, professionalWords: LESSON?.professionalWords || [] };
  const wordTokens = (text) => LEXICON.inspect(text, ST.teacher ? 0 : ST.level, lexiconOptions);
  const NET = window.CDG_NET ? window.CDG_NET.createClient() : null;
  let capabilities = {}, privacy = {}, conversationOpen = false, currentStep = '', cloudRecording = null, micBusy = false, micConsent = false;
  let speechDialog = null, npcDialog = null, micEpoch = 0;
  let attemptSource = 'text', speechResult = null, promptSerial = 0;
  const chatHistory = [];
  const npcTiming = window.CDG_NPC_TIMING.create();
  let pendingNpcReply = null;
  const lessonId = () => LESSON?.id || 'nev-l4';
  const track = (type, payload = {}) => { if (NET) void NET.event(lessonId(), type, { station: ST.station, step: currentStep, ...payload }); };
  const turnContext = (userText, role = 'wang') => ({ lesson: lessonId(), station: ST.station || 'intro', step: currentStep || 'free-question', role,
    level: ST.teacher ? 0 : ST.level, plugged: ST.plugged, focus: ST.focus, userText, history: chatHistory.slice(-6),
    allowedWords: LESSON?.vocabulary || ['发动机', '驱动电机', '动力电池', '也', '对吗'], allowedErrors: [], facts: L.FACT, budget: { timeoutMs: 2500 } });

  function cancelNpcReply(reason) { pendingNpcReply?.cancel(reason); pendingNpcReply = null; }
  function beginNpcReply(role, kind, current, waiting, submittedAt) {
    cancelNpcReply('superseded');
    const timing = npcTiming.begin({ role, kind, submittedAt });
    let cue = null, answer = null, timer = null, waitingCleanup = null;
    const live = () => pendingNpcReply === handle && current();
    const clearCue = () => { clearTimeout(timer); cue?.cancel(); waitingCleanup?.(); waitingCleanup = null; };
    const handle = {
      cancel(reason) { clearCue(); answer?.cancel(); timing.cancel(reason); },
      received(result) { clearCue(); if (!live()) { timing.cancel('stale'); return false; } timing.received(result); return true; },
      present(result) {
        if (!live()) return;
        // Two animation frames provide a rendering opportunity; not a physical display or streaming-token measurement.
        requestAnimationFrame(() => requestAnimationFrame(() => { if (live() && !document.hidden) timing.frame(); else timing.cancel('stale'); }));
        answer = voiceOutput.play(result.zh, role, { onStart: () => { if (live()) timing.speechStarted('answer'); } });
        void answer.finished.then(value => timing.speechFinished('answer', value));
      },
    };
    pendingNpcReply = handle;
    timer = setTimeout(() => {
      if (!live() || !NET?.enabled || document.hidden) return;
      const line = '嗯，我想一想。'; timing.cueRequested(); waitingCleanup = waiting(line) || null;
      cue = voiceOutput.play(line, role, { onStart: () => { if (live()) timing.speechStarted('cue'); } });
      void cue.finished.then(value => timing.speechFinished('cue', value));
    }, 900);
    return handle;
  }

  async function toggleOnline() {
    if (!NET) return;
    const b = $('tools').querySelector('[data-t="online"]');
    if (NET.enabled) { NET.setEnabled(false); cancelNpcReply('offline'); voiceOutput.stop(); if (speechDialog || npcDialog) closeModal(); cancelCloudRecording(); if (rec) rec.abort(); capabilities = {}; privacy = {}; micConsent = false; b.textContent = '离线'; b.setAttribute('aria-pressed', 'false'); toast('已切回离线；所有课程步骤和离线语料仍可用。'); return; }
    if (!/^https?:$/.test(location.protocol)) { toast('这是离线文件。需要联机时，请从本机服务地址打开；当前仍可完整上课。'); return; }
    NET.setEnabled(true); b.textContent = '连接中…';
    try {
      const s = await NET.request('/api/status'); if (!NET.enabled) return;
      capabilities = s.capabilities || {}; privacy = s.privacy || {}; micConsent = false; b.textContent = '联机'; b.setAttribute('aria-pressed', 'true');
      toast(capabilities.npc ? '联机增强已启用，课堂流程仍由本地控制。' : '服务已连接；对话模型未配置，当前由课堂脚本回答。');
      track('session_start', { level: ST.level, plugged: ST.plugged });
    } catch (_) { NET.setEnabled(false); b.textContent = '离线'; toast('服务暂时连不上，继续离线上课。'); }
  }
  function voiceNotice() {
    const providers = Array.isArray(privacy.speech?.providers) ? privacy.speech.providers.slice(0, 2) : [];
    let html = '<p>语音由以下服务处理。应用不保存录音或自由转写；你也可以继续打字、输入拼音或点选。</p>';
    if (privacy.operatorName) html += `<p>课件运营方：${esc(privacy.operatorName)}</p>`;
    for (const p of providers) {
      let policy = '';
      try { const u = new URL(p.policyUrl); if (u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash) policy = ` <a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">服务商隐私说明</a>`; } catch (_) {}
      html += `<p>${p.kind === 'assessment' ? '跟读评测' : '语音识别'}：${esc(p.name || '提供方未填写')}<br>处理地域：${esc(p.region || '未填写')}<br>供应商保存规则：${esc(p.audioRetention || '未填写，请向部署方确认')}${policy}</p>`;
    }
    if (!providers.length && (capabilities.asr || capabilities.assessment)) html += '<p>部署方尚未填写云语音提供方、处理地域与保存规则，请先向部署方确认。</p>';
    html += `<p>${providers.length || capabilities.asr || capabilities.assessment ? '云端失败时会尝试' : '当前使用'}浏览器识别。它可能把音频发送至浏览器厂商的网络服务，地域与保存方式取决于浏览器；这里只识别文字，不评发音。</p>`;
    if (privacy.events?.enabled === false) html += '<p>当前不新增保存匿名学习事件。</p>';
    else if (Number.isInteger(privacy.events?.retentionDays)) html += `<p>匿名学习事件保留 ${privacy.events.retentionDays} 天，之后在下次记录或教师查询时清理。不同于供应商保存录音的规则。</p>`;
    return `<div class="voice-notice">${html}</div>`;
  }
  function askMaster() {
    if (conversationOpen) return;
    voiceOutput.stop();
    cancelCloudRecording(); if (rec) { const old = rec; rec = null; try { old.abort(); } catch (_) {} }
    const m = modal(`<button class="close" data-x="1" aria-label="返回课堂">×</button><h2>问师傅</h2><p class="sub">先问清楚，再回到刚才那一步。可用中文或拼音。</p>
      <label class="npc-role">和谁说 <select aria-label="对话伙伴"><option value="wang">王明师傅</option><option value="dragon">小龙学徒</option></select></label>
      <form class="npc-form"><input aria-label="想问师傅的问题" maxlength="300" placeholder="例如：纯电动汽车有发动机吗？"><button type="submit">问一问</button></form>
      <div class="npc-voice-controls"><button type="button" data-npc-mic>用语音说</button><span data-npc-voice-status role="status"></span></div>
      <div class="npc-consent hidden">${voiceNotice()}<button type="button" data-npc-consent>同意本次语音练习</button></div>
      <div class="npc-answer" aria-live="polite"></div><p class="pending">${NET?.enabled ? '联机回答经过校验；服务失败时使用本地回答。' : '当前离线：可以查询三种车的基本属性。'}</p>`);
    conversationOpen = true;
    const form = m.querySelector('form'), inp = form.querySelector('input'), out = m.querySelector('.npc-answer');
    const dialog = npcDialog = { m, flow: FLOW, voice: null };
    let seq = 0, role = 'wang', voiceInput = null;
    const mic = m.querySelector('[data-npc-mic]'), voiceStatus = m.querySelector('[data-npc-voice-status]');
    const live = () => npcDialog === dialog && dialog.flow === FLOW && m.isConnected;
    dialog.voice = window.CDG_NPC_VOICE.create({ client: NET, capabilities: () => capabilities, current: live,
      context: () => ({ lesson: lessonId(), station: ST.station || 'intro', step: currentStep || 'free-question' }),
      onState(phase) { mic.disabled = ['permission','sending'].includes(phase); mic.textContent = ['recording','browser'].includes(phase) ? '停止录音' : '用语音说'; voiceStatus.textContent = ({ permission:'正在打开麦克风…', recording:'正在录音…', browser:'浏览器正在识别…', sending:'正在识别…' })[phase] || ''; },
      onTranscript(text, source) { inp.value = text; voiceInput = { text, source }; voiceStatus.textContent = '请看一下识别文字，再点“问一问”。'; inp.focus(); },
      onError(code) { voiceStatus.textContent = ({ offline:'先开启“联机”，或继续打字。', cloud_failed:'云端识别未成功，尝试浏览器识别。', browser_unavailable:'浏览器不支持识别，可以打字或输入拼音。', browser_failed:'没有识别成功，可以再试或打字。', microphone_denied:'麦克风未打开，可以继续打字。', empty_audio:'没有录到声音，请再试一次。' })[code] || '语音暂不可用，可以继续打字。'; },
    });
    const startVoice = () => { seq++; cancelNpcReply('recording'); voiceOutput.stop(); if (form.querySelector('button').disabled) out.textContent = ''; form.querySelector('button').disabled = false; void dialog.voice.toggle(); };
    mic.onclick = () => { if (!NET?.enabled) { voiceStatus.textContent = '先开启“联机”，或继续打字。'; return; } if (!micConsent) { m.querySelector('.npc-consent').classList.remove('hidden'); return; } startVoice(); };
    m.querySelector('[data-npc-consent]').onclick = () => { micConsent = true; m.querySelector('.npc-consent').classList.add('hidden'); startVoice(); };
    inp.addEventListener('input', () => { voiceInput = null; });
    m.querySelector('select').onchange = e => { role = e.target.value; seq++; cancelNpcReply('superseded'); dialog.voice.cancel(); voiceInput = null; chatHistory.splice(0); out.textContent = ''; form.querySelector('button').disabled = false; m.querySelector('h2').textContent = role === 'dragon' ? '和小龙说' : '问师傅'; };
    form.addEventListener('submit', async e => {
      const submittedAt = performance.now(); e.preventDefault(); const text = inp.value.trim(); if (!text) return; const n = ++seq, flow = FLOW;
      dialog.voice.cancel();
      if (voiceInput?.text === text) { ST.spoken++; gauges(); track('speak_attempt', { asrOk: true, inputMode: voiceInput.source }); } voiceInput = null;
      out.textContent = role === 'dragon' ? '小龙在想…' : '师傅在听…'; form.querySelector('button').disabled = true;
      voiceOutput.stop();
      const reply = beginNpcReply(role, 'question', () => n === seq && flow === FLOW && live(), line => {
        out.innerHTML = `<div class="npc-waiting">${ruby(line)}<div class="cap-gloss">${gloss(line)}</div><small>Let me think.</small></div>`;
      }, submittedAt);
      let fallback = { zh: '我们先看看这辆车。', en: 'Let’s look at this car first.' };
      try { const q = L.parseQuestion(text, ST.focus); if (q.ok) { const a = L.answerQuestion(q); fallback = { zh: typeof a === 'string' ? a : fallback.zh, en: '' }; } } catch (_) {}
      const r = NET ? await NET.turn(turnContext(text, role), fallback) : fallback;
      if (!reply.received(r)) return;
      out.innerHTML = `<div class="npc-line">${ruby(r.zh)}</div><div class="cap-gloss">${gloss(r.zh)}</div><p>${esc(r.en || '')}</p><small>${r.source === 'llm' ? 'AI 辅助回答，不计入语料证据' : '课堂参考回答'}</small>`;
      form.querySelector('button').disabled = false; reply.present(r);
      chatHistory.push({ who: 'you', zh: text }, { who: role, zh: r.zh }); if (chatHistory.length > 6) chatHistory.splice(0, chatHistory.length - 6);
    }); inp.focus();
  }

  // =========================================================== 3D
  let R;
  try { R = new E.Renderer($('world')); } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div class="modal"><div class="box"><h2>这台设备不支持 WebGL</h2><p>3D 车间需要 WebGL。请换用 Edge / Chrome，或在带显卡的电脑上打开。</p></div></div>`);
    throw e;
  }
  const cam = new E.Camera();
  const W = WD.buildWorld();
  const characters = window.CDG_CHARACTERS?.create(W, R);
  async function selectCharacter(id) {
    if (!characters) return;
    try {
      await characters.select(id);
      const select = $('characterSelect'); if (select && !characters.state.loading && characters.state.active) select.value = characters.state.active;
    } catch (_) {
      const select = $('characterSelect'); if (select && characters.state.active) select.value = characters.state.active;
      toast('小龙模型暂时没有载入，请重新选择。课堂可以继续。');
    }
  }
  function chooseCharacter() {
    if (!characters?.options.length) return;
    const m = modal(`<button class="close" data-x="1" aria-label="返回课堂">×</button><h2>小龙形象</h2><p>选择这节课的学习伙伴形象。学习内容和进度保持不变。</p><div class="btns">${characters.options.map(o=>`<button type="button" data-character="${esc(o.id)}" aria-pressed="${characters.state.active===o.id}">${esc(o.name)}</button>`).join('')}</div>`);
    m.addEventListener('click',e=>{const b=e.target.closest('[data-character]');if(b){void selectCharacter(b.dataset.character);closeModal();}});
  }
  // ---- Marble 场景（World Labs 高斯泼溅）：作为车间环境，可交互的车、零件、人物仍是网格 ----
  const SPL = window.CDG_SPLAT;
  let SW = null; try { if (R.webgl2 && SPL) SW = new SPL.SplatWorld(R.gl); } catch (e) { console.warn('splat init', e); }
  const MAR = { name: '', format: '', n: 0, loaded: false, hideShell: true, autoLOD: true, loadSerial: 0, phase: '' };
  const placeKey = (nm) => 'cdg.marble.place.' + nm;
  const defaultPlace = (meta) => (meta && meta.metricScale ? { scale: meta.metricScale, flip: true, y: meta.groundOffset || 0, x: 0, z: 0, yaw: 0 } : { scale: 1, flip: true, y: 1.5, x: 0, z: 0, yaw: 0 });
  async function loadMarble(buf, name, meta, place) {
    if (!SW) { toast('这台设备不支持 WebGL2，无法显示 Marble 场景'); return false; }
    const serial = ++MAR.loadSerial;
    toast(`正在载入 Marble 场景：${esc(name)} …`);
    try {
      let pl = place || null; try { const s0 = localStorage.getItem(placeKey(name)); if (s0) pl = JSON.parse(s0); } catch (e) {}
      SW.place = Object.assign({ scale: 1, yaw: 0, flip: true, x: 0, y: 0, z: 0 }, pl || defaultPlace(meta));
      if (pl && pl.bright) SW.bright = pl.bright;
      await SW.load(buf, name, { pointBudget: 100000, onProgress(progress) {
        if (serial !== MAR.loadSerial) return;
        const phases = { loading: '正在读取场景', decompress: '正在解压场景', decode: '正在解析场景', decoded: '解析完成', select: '正在选择场景细节', pack: '正在准备画面', ready: '' };
        MAR.phase = phases[progress.phase] ?? '';
        const label = scenePanel?.querySelector('[data-load-status]'); if (label) label.textContent = MAR.phase;
      } });
      if (serial !== MAR.loadSerial) return false;
      const d = SW.src;
      SW.setAutoLOD({ enabled: MAR.autoLOD, targetMs: 1000 / 30, minPoints: 25000 }); R.splat = SW;
      MAR.meta = meta || null; MAR.saved = !!pl;
      applyLayout('marble');
      Object.assign(MAR, { name, format: d.format, n: d.n, loaded: true });
      W.shell.visible = !MAR.hideShell;
      R.env.clear = hex('#e9e4da');
      if (!pl && !(meta && meta.metricScale)) autoAlign(); else fitLayout();
      toast(`Marble 场景已载入：${esc(name)} · 当前显示 ${SW.getMetadata().activePoints.toLocaleString()} 个点`, 'zhu');
      renderScenePanel(); return true;
    } catch (e) { if (serial === MAR.loadSerial) { MAR.phase = ''; console.error(e); toast('载入失败：' + esc(e.message || e)); renderScenePanel(); } return false; }
  }
  // 自动对齐：地面放到 y=0，房间中心对准车间布局中心（保持 Marble 的真实尺度）
  // ---- 房间边界：用高斯点 5%–95% 分位数估计（不是语义分割，也不是米制标定）----
  let ROOM = null, FIT = [];
  const metric = () => !!(MAR.meta && MAR.meta.metricScale);
  function measureRoom() {
    if (!SW || !SW.n) { ROOM = null; return; }
    const st = SW.stats();
    ROOM = { x0: st.x5, x1: st.x95, z0: st.z5, z1: st.z95, y1: Math.max(2.2, st.y97) };
  }
  // 布局按房间实际跨度摆：车在原点不动，展示区贴右墙、货架贴左后角、充电桩贴左前；放不下的写进 FIT
  function fitLayout(roomOverride) {
    if (roomOverride) ROOM = roomOverride; else measureRoom(); FIT = [];
    if (!ROOM || LAY.kind !== 'marble') return;
    const m = 0.6, R0 = ROOM, inX = (a, b) => a >= R0.x0 + m && b <= R0.x1 - m, inZ = (a, b) => a >= R0.z0 + m && b <= R0.z1 - m;
    // 展示区：车身在本地 x∈[8.5,13.5]（含质检框），z∈[-5.3,5.3]；尽量贴右墙，但不压到举升机（x>3.4）
    const want = R0.x1 - m - 13.5, dx = Math.max(3.4 - 8.5, want);
    LAY.showDx = dx; W.showArea.pos = [dx, 0, 0];
    if (!inX(8.5 + dx, 13.5 + dx) || dx > want + 1e-6) FIT.push(`三车展示区要 5 米宽，右边只剩 ${(R0.x1 - m - 3.4).toFixed(1)}`);
    if (!inZ(-4.9, 4.9)) FIT.push(`三车展示区要 9.8 进深，房间只有 ${(R0.z1 - R0.z0 - 2 * m).toFixed(1)}`);
    // 货架：宽 4.9，靠左后
    const shx = Math.max(R0.x0 + m + 2.45, -4.6), shz = Math.max(R0.z0 + m + 0.4, -4.4);
    LAY.shelf = [shx, 0, shz]; W.shelf.root.pos = [...LAY.shelf];
    if (shx + 2.45 > -1.4) FIT.push('零件货架和举升机挤在一起');
    // 充电桩：左前
    const cx = Math.max(R0.x0 + m + 0.4, -2.8), cz = Math.min(R0.z1 - m - 0.4, 2.0);
    LAY.charger = [cx, 0, cz]; W.charger.moveTo(LAY.charger);
    // 人物：站在展示台前沿（展示台前沿 z=4.9）
    const sc = 11 + dx, front = Math.min(R0.z1 - m - 0.2, 5.6);
    LAY.wangShow = [Math.min(R0.x1 - m, sc + 2.0), 0, front];
    LAY.dragonShow = [Math.min(R0.x1 - m, sc + 0.6), 0, Math.min(R0.z1 - m - 0.4, 5.7)];
    if (front < 5.2) FIT.push('王明、小龙站不到展示台前面（前面空间不够）');
    // 镜头目标跟着展示区走
    for (const k of ['show', 'inspect']) VIEWS[k].target = [6.2 + (dx - LAYOUTS.marble._dx0), VIEWS[k].target[1], VIEWS[k].target[2]];
    LAY.endCam[0].target = [7.2 + (dx - LAYOUTS.marble._dx0), 0.9, 3.1]; LAY.endCam[1].target = [12 + (dx - LAYOUTS.marble._dx0), 0.9, 3.1];
    if (!inX(-2.4, 4.0) || !inZ(-1.9, 2.4)) FIT.push('举升机工位（约 6.4 × 4.3）超出房间');
  }
  // 相机限位：眼睛位置不出房间（按房间边界缩短距离），天花板以下
  function clampCam() {
    if (!ROOM || !MAR.loaded || !R.splat) return;
    const R0 = ROOM, m = 0.35;
    cam.target[0] = Math.min(R0.x1 - m, Math.max(R0.x0 + m, cam.target[0]));
    cam.target[2] = Math.min(R0.z1 - m, Math.max(R0.z0 + m, cam.target[2]));
    const cp = Math.cos(cam.pitch), dir = [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), cp * Math.cos(cam.yaw)];
    let lim = cam.dist;
    const lims = [[0, R0.x0 + m, R0.x1 - m], [2, R0.z0 + m, R0.z1 - m], [1, 0.25, R0.y1 - m]];
    for (const [k, lo, hi] of lims) {
      const d = dir[k], t = cam.target[k];
      if (d > 1e-4) lim = Math.min(lim, (hi - t) / d); else if (d < -1e-4) lim = Math.min(lim, (lo - t) / d);
    }
    cam.dist = Math.max(1.2, lim);
  }
  function autoAlign() {
    if (!SW || !SW.n) return;
    const st = SW.stats(), P = SW.place;
    // 地面：低处 3% 分位数；房间中心：对准插电工坊布局中心（车在 x=0，展示区在右，中心约 x=1.2）
    SW.setPlacement({ y: P.y - st.y3, x: P.x + 1.2 - (st.x5 + st.x95) / 2, z: P.z + 0.3 - (st.z5 + st.z95) / 2 });
    fitLayout(); renderScenePanel();
    const u = metric() ? '米' : '个场景单位（未标定，不一定等于米）';
    toast(`已自动对齐。估计跨度 ${(ROOM.x1 - ROOM.x0).toFixed(1)} × ${(ROOM.z1 - ROOM.z0).toFixed(1)} ${u}。${FIT.length ? '有 ' + FIT.length + ' 处放不下，见“场景”面板' : '各工位都放得下'}`);
  }
  function unloadMarble() { MAR.loadSerial++; MAR.phase = ''; R.splat = null; MAR.loaded = false; ROOM = null; FIT = []; W.shell.visible = true; R.env.clear = hex('#efe7d8'); applyLayout('code'); renderScenePanel(); }
  function b64ToBuf(b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
    if (!/\.(spz|ply|splat)$/i.test(f.name)) { toast('请拖入 Marble 导出的 .spz（或 .ply / .splat）文件'); return; }
    await loadMarble(await f.arrayBuffer(), f.name);
  });
  let scenePanel = null, placeT = null, placePend = {};
  function toggleScenePanel() { if (scenePanel) { scenePanel.remove(); scenePanel = null; return; } scenePanel = document.createElement('div'); scenePanel.className = 'compare scene-panel'; document.body.append(scenePanel); renderScenePanel(); }
  function renderScenePanel() {
    if (!scenePanel) return;
    const P = SW ? SW.place : {};
    const sl = (k, label, min, max, step, val) => `<label class="sl"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}"><em>${(+val).toFixed(2)}</em></label>`;
    scenePanel.innerHTML = `<h3>场景 · Marble <button type="button" data-sx="1">×</button></h3>
      <div class="title">${MAR.loaded ? `当前：Marble 场景 · ${esc(MAR.name)}<br><small style="font:12px var(--ll-sans);color:var(--ll-soft)">${esc(MAR.format)} · ${MAR.n.toLocaleString()} 个高斯点</small>` : '当前：代码画的低多边形车间'}</div>
      <div style="padding:8px 12px 12px">
        ${SW ? '' : '<div class="lock">这台设备不支持 WebGL2，不能显示 Marble 场景。</div>'}
        <label class="btnfile">载入 Marble 文件（.spz / .ply / .splat）<input type="file" accept=".spz,.ply,.splat" data-file="1" hidden></label>
        <div class="pending" data-load-status role="status">${esc(MAR.phase)}</div>
        <div class="pending" style="margin:6px 0 10px">也可以直接把文件拖进窗口。在 Marble 网页里导出 Gaussian Splat（.spz）即可。车、零件、王明和小龙会叠在场景上，照常可以点、可以学。</div>
        ${MAR.loaded ? `<label class="chk"><input type="checkbox" data-hide="1" ${MAR.hideShell ? 'checked' : ''}> 隐藏代码画的墙、地面、灯</label>
        <label class="chk">场景细节 <select data-point-budget="1" aria-label="场景点数上限">${splatOptions()}</select></label>
        <label class="chk"><input type="checkbox" data-auto-lod="1" ${MAR.autoLOD ? 'checked' : ''}> 画面持续卡顿时减少场景点数</label><div class="pending" data-lod-status>${splatStatus()}</div>
        <label class="chk"><input type="checkbox" data-flip="1" ${P.flip ? 'checked' : ''}> 上下翻转（Marble 导出的一般要勾上）</label>
        ${sl('scale', '缩放', 0.2, 6, 0.01, P.scale)}${sl('y', '高度', -6, 6, 0.01, P.y)}${sl('yaw', '旋转', -3.1416, 3.1416, 0.01, P.yaw)}${sl('x', '左右', -25, 25, 0.05, P.x)}${sl('z', '前后', -25, 25, 0.05, P.z)}${sl('bright', '亮度', 0.5, 1.6, 0.01, SW.bright)}
        <div class="btns"><button type="button" data-auto="1">自动对齐</button><button type="button" data-save="1">保存位置</button><button type="button" data-copy="1">复制参数</button><button type="button" data-unload="1" class="ghost">换回代码车间</button></div>
        <div class="pending" data-out="1" style="margin-top:6px;word-break:break-all"></div>
        <div data-fit="1" style="margin-top:8px">${fitHtml()}</div>` : ''}
      </div>`;
  }
  function fitHtml() {
    if (!ROOM) return '';
    const u = metric() ? '米' : '场景单位';
    return `<div class="lock" style="border-style:solid">估计跨度 ${(ROOM.x1 - ROOM.x0).toFixed(1)} × ${(ROOM.z1 - ROOM.z0).toFixed(1)} ${u}（按高斯点分布估计，不是实测）。${FIT.length ? '<br><b style="color:var(--ll-new)">放不下：</b>' + FIT.map(esc).join('；') + '。可以把“缩放”调大一点，或换一个更宽的车间。' : '<br>各工位都在房间里。'}</div>`;
  }
  function splatStatus() { const m = SW?.getMetadata(); return m ? `显示 ${m.activePoints.toLocaleString()} / ${m.sourcePoints.toLocaleString()} 个点；车辆和可操作零件保持完整。` : ''; }
  function splatOptions() { const current = SW.getMetadata().requestedBudget; return [...new Set([25000,50000,100000,250000,500000,current])].sort((a,b) => a-b).map(n => `<option value="${n}" ${current === n ? 'selected' : ''}>${n/10000} 万点</option>`).join(''); }
  document.addEventListener('input', (e) => {
    const r = e.target; if (!r.closest || !r.closest('.scene-panel') || r.type !== 'range' || !SW) return;
    const k = r.dataset.k, v = parseFloat(r.value); if (r.nextElementSibling) r.nextElementSibling.textContent = v.toFixed(2);
    if (k === 'bright') { SW.bright = v; return; }
    placePend[k] = v; if (placeT) return; placeT = setTimeout(() => { SW.setPlacement(placePend); placePend = {}; placeT = null; fitLayout(); const fr = scenePanel && scenePanel.querySelector('[data-fit]'); if (fr) fr.innerHTML = fitHtml(); }, 120);
  });
  document.addEventListener('change', async (e) => {
    const t = e.target; if (!t.closest || !t.closest('.scene-panel')) return;
    if (t.dataset.file && t.files && t.files[0]) await loadMarble(await t.files[0].arrayBuffer(), t.files[0].name);
    if (t.dataset.hide) { MAR.hideShell = t.checked; W.shell.visible = !t.checked; }
    if (t.dataset.flip && SW) { SW.setPlacement({ flip: t.checked }); fitLayout(); renderScenePanel(); }
    if (t.dataset.pointBudget && SW) { SW.setPointBudget(Number(t.value)); renderScenePanel(); }
    if (t.dataset.autoLod && SW) { MAR.autoLOD = t.checked; SW.setAutoLOD({ enabled: t.checked, targetMs: 1000 / 30, minPoints: 25000 }); }
  });
  document.addEventListener('click', (e) => {
    const t = e.target; if (!t.closest || !t.closest('.scene-panel')) return;
    if (t.closest('[data-sx]')) return toggleScenePanel();
    if (t.closest('[data-save]')) { try { localStorage.setItem(placeKey(MAR.name), JSON.stringify(Object.assign({}, SW.place, { bright: SW.bright }))); toast('已保存：下次打开同一个场景文件，自动用这个位置'); } catch (e2) { toast('保存失败（浏览器禁止本地存储）'); } }
    if (t.closest('[data-copy]')) { const s1 = JSON.stringify(Object.assign({}, SW.place, { bright: SW.bright })); const out = scenePanel.querySelector('[data-out]'); if (out) out.textContent = s1; if (navigator.clipboard) navigator.clipboard.writeText(s1).catch(() => {}); }
    if (t.closest('[data-unload]')) unloadMarble();
    if (t.closest('[data-auto]')) autoAlign();
  });

  const VIEWS = {
    overview: { target: [2, 1.0, 0.5], yaw: 0.62, pitch: 0.3, dist: 14.5 },
    car: { target: [0, 1.35, 0], yaw: 0.72, pitch: 0.2, dist: 7.6 },
    charger: { target: [-2.3, 1.25, 1.6], yaw: 0.78, pitch: 0.16, dist: 5.6 },
    shelf: { target: [-8.6, 1.35, -6.4], yaw: 0.28, pitch: 0.1, dist: 6.6 },
    board: { target: [0.2, 0.35, 0], yaw: 0.36, pitch: 0.13, dist: 8.6 },
    dragon: { target: [1.4, 0.25, 2.2], yaw: 0.55, pitch: 0.12, dist: 6.4 },
    show: { target: [11, 0.9, 0.4], yaw: 1.2, pitch: 0.2, dist: 12.5 },
    inspect: { target: [11, 1.0, 3.1], yaw: 1.05, pitch: 0.2, dist: 7.2 },
  };
  // 两套布局：代码车间（宽敞）/ Marble 车间（紧凑，相机始终在房间里）
  const VIEWS_CODE = JSON.parse(JSON.stringify(VIEWS));
  const VIEWS_MARBLE = {
    overview: { target: [1.2, 1.0, 0.2], yaw: 0.5, pitch: 0.22, dist: 8.2 },
    car: { target: [0, 1.3, 0], yaw: 0.68, pitch: 0.18, dist: 6.2 },
    charger: { target: [-1.9, 1.2, 1.3], yaw: 0.75, pitch: 0.14, dist: 4.4 },
    shelf: { target: [-4.6, 1.35, -4.2], yaw: 0.28, pitch: 0.1, dist: 4.6 },
    board: { target: [0.2, 0.35, 0], yaw: 0.36, pitch: 0.13, dist: 7.0 },
    dragon: { target: [1.4, 1.1, 2.0], yaw: 0.5, pitch: 0.1, dist: 5.0 },
    show: { target: [6.2, 0.9, 0.3], yaw: 0.6, pitch: 0.18, dist: 7.0 },
    inspect: { target: [6.2, 1.0, 3.1], yaw: 0.75, pitch: 0.2, dist: 5.0 },
  };
  const LAYOUTS = {
    code: { showDx: 0, shelf: [-8.6, 0, -6.6], charger: [-3.4, 0, 2.4], wangShow: [8.5, 0, 7.5], dragonShow: [11.5, 0, 5.8], endCam: [{ target: [12, 0.9, 3.1], yaw: 1.45, pitch: 0.18, dist: 9 }, { target: [23, 0.9, 3.1], yaw: -1.2, pitch: 0.16, dist: 11 }], views: VIEWS_CODE },
    marble: { _dx0: -4.8, showDx: -4.8, shelf: [-4.6, 0, -4.4], charger: [-2.8, 0, 2.0], wangShow: [9.6, 0, 4.6], dragonShow: [9.8, 0, 2.6], endCam: [{ target: [7.2, 0.9, 3.1], yaw: 0.9, pitch: 0.18, dist: 6.5 }, { target: [12, 0.9, 3.1], yaw: 0.7, pitch: 0.16, dist: 7.5 }], views: VIEWS_MARBLE },
  };
  const freshLayout = (k) => { const o = JSON.parse(JSON.stringify(Object.assign({}, LAYOUTS[k], { views: null }))); o.views = LAYOUTS[k].views; o.kind = k; return o; };
  let LAY = freshLayout('code');
  function applyLayout(k) {
    LAY = freshLayout(k);
    for (const v of Object.keys(LAY.views)) VIEWS[v] = JSON.parse(JSON.stringify(LAY.views[v]));
    W.showArea.pos = [LAY.showDx, 0, 0];
    W.shelf.root.pos = [...LAY.shelf];
    W.charger.moveTo(LAY.charger);
  }
  const camTo = (v, d = 1.2) => E.camTo(cam, v, d);
  const partView = (key, P = W.car) => { const p = P[key].worldPos(); return { target: [p[0], p[1] + 0.25, p[2]], yaw: 0.7, pitch: 0.22, dist: 4.4 }; };
  cam.target = [...VIEWS.overview.target]; cam.yaw = VIEWS.overview.yaw; cam.pitch = VIEWS.overview.pitch; cam.dist = VIEWS.overview.dist;
  E.orbitControls($('world'), cam, onTap);

  // ---- 动画状态 ----
  const anim = { wheels: 0, motor: 0, shake: 0, pulse: null, showWheels: 0 };
  function setEmis(node, c) { node.traverse((n) => { if (!n.mesh) return; if (!n._e0) n._e0 = n.emis.slice(); n.emis = c || n._e0; }); }
  function focusPart(key, P = W.car) { if (anim.pulse) setEmis(anim.pulse, null); anim.pulse = key ? P[key] : null; ST.partLbl = key; }
  function flows(P, o) { for (const k of Object.keys(P.flows)) if (k in o) P.flows[k].on = o[k]; }
  let last = performance.now(), T = 0;
  function frame(now) {
    const frameMs = now - last, dt = Math.min(0.05, frameMs / 1000); last = now; T += dt;
    if (MAR.loaded && MAR.autoLOD && !document.hidden && SW.observeFrame(frameMs)) {
      const status = scenePanel?.querySelector('[data-lod-status]'); if (status) status.textContent = splatStatus();
      const select = scenePanel?.querySelector('[data-point-budget]'); if (select) select.innerHTML = splatOptions();
    }
    E.stepTweens(dt);
    clampCam();
    for (const f of W.allFlows()) f.update(dt);
    W.sparks.update(dt);
    const wsp = anim.wheels > 0 || W.car.flows.fuel.on || W.car.flows.elec.on ? 7 : 0; anim.wheels = Math.max(0, anim.wheels - dt);
    for (const w of W.car.wheels) w.rot[1] += wsp * dt;
    if (anim.showWheels) for (const w of W.show.phev.wheels) w.rot[1] += anim.showWheels * dt;
    if (anim.motor > 0) { anim.motor -= dt; W.car.motorSpin.rot[2] += 18 * dt; }
    if (anim.shake > 0) { anim.shake -= dt; W.car.engine.pos[1] = 0.64 + Math.sin(T * 60) * 0.012; } else if (W.car.engine) W.car.engine.pos[1] = 0.64;
    if (anim.pulse) { const k = (Math.sin(T * 4.5) + 1) / 2; setEmis(anim.pulse, [0.16 + 0.22 * k, 0.11 + 0.15 * k, 0.03 + 0.04 * k]); }
    // 小龙待机
    const dr = W.dragon; if (dr.root.visible) { dr.body.pos[1] = Math.abs(Math.sin(T * 2.2)) * 0.04; dr.tail.rot[1] = Math.sin(T * 3) * 0.35; }
    fadeOccluders(dt);
    R.render(W.root, cam);
    updateLabels();
    requestAnimationFrame(frame);
  }

  function fadeOccluders(dt) {
    if (!W.occluders) return;
    const e = cam.eye, t = cam.target, dx = t[0] - e[0], dz = t[2] - e[2], L2 = dx * dx + dz * dz;
    for (const o of W.occluders) {
      let goal = 1;
      if (L2 > 1e-6) {
        const c = o.nodes[0].worldPos(), k = ((c[0] - e[0]) * dx + (c[2] - e[2]) * dz) / L2;
        if (k > 0.02 && k < 0.98) { const px = e[0] + dx * k - c[0], pz = e[2] + dz * k - c[2]; if (px * px + pz * pz < 0.25) goal = 0.16; }
      }
      o.a += (goal - o.a) * Math.min(1, dt * 8);
      const a = o.a > 0.99 ? 1 : o.a;
      for (const n of o.nodes) n.alpha = a;
    }
  }

  // ---- 3D 标签 ----
  const LBL = [];
  // 浮动标签（人名、车名、部件、充电枪、质检章）参与防重叠；货架上的搭配标签按格子排好，不动
  const FLOAT_PRI = { part: 4, plaque: 3, stamp: 3, name: 2, carname: 1 };
  function label(html, cls, pos, opts = {}) {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.innerHTML = html; $('labels').append(el);
    const k0 = cls.split(' ')[0];
    const o = { el, pos, show: opts.show || (() => true), maxDist: opts.maxDist || 0, pri: FLOAT_PRI[k0] || 0, center: k0 === 'plaque' || k0 === 'stamp', dy: 0 };
    if (opts.click) el.addEventListener('click', (e) => { e.stopPropagation(); opts.click(); });
    LBL.push(o); return o;
  }
  let LFR = 0;
  function updateLabels() {
    const w = innerWidth, h = innerHeight, fl = []; LFR++;
    for (const o of LBL) {
      const p = typeof o.pos === 'function' ? o.pos() : o.pos;
      if (!p || !o.show()) { o.el.style.display = 'none'; o.dy = 0; continue; }
      const s = cam.project(p, w, h);
      if (!s || s.x < -150 || s.x > w + 150 || s.y < -60 || s.y > h + 60 || (o.maxDist && s.depth > o.maxDist)) { o.el.style.display = 'none'; o.dy = 0; continue; }
      o.el.style.display = ''; o.el.style.left = s.x.toFixed(1) + 'px'; o.el.style.top = s.y.toFixed(1) + 'px'; o.el.style.zIndex = String(Math.max(1, 900 - Math.round(s.depth * 10)));
      if (o.pri) { o.sx = s.x; o.sy = s.y; o.depth = s.depth; fl.push(o); }
    }
    // 防重叠：重要的、离镜头近的先放；后放的被挡住就往上让（最多 120px），让不开就变淡
    fl.sort((a, b) => b.pri - a.pri || a.depth - b.depth);
    const boxes = [];
    for (const o of fl) {
      if (!o.w || LFR % 20 === 0) { o.w = o.el.offsetWidth || 0; o.h = o.el.offsetHeight || 0; }
      if (!o.w || !o.h) continue;
      const top0 = o.center ? o.sy - o.h / 2 : o.sy - o.h;
      let dy = 0, ok = false;
      for (let it = 0; it < 4 && dy <= 120; it++) {
        const bx = [o.sx - o.w / 2 - 3, top0 - dy - 3, o.sx + o.w / 2 + 3, top0 - dy + o.h + 3];
        const hit = boxes.find((b) => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1]);
        if (!hit) { ok = true; boxes.push(bx); break; }
        dy += bx[3] - hit[1];
      }
      if (!ok) dy = 0;
      o.dy += (dy - o.dy) * 0.35;
      if (Math.abs(o.dy) > 0.5) o.el.style.top = (o.sy - o.dy).toFixed(1) + 'px';
      o.el.style.opacity = ok ? '' : '0.4';
    }
  }
  const PART = { engine: '发动机', motor: '驱动电机', battery: '动力电池', port: '插电式', tank: '燃油' };
  const PARTZH = { engine: '发动机', motor: '驱动电机', battery: '动力电池', port: '充电口 · 插电式', tank: '燃油' };
  for (const k of Object.keys(PART)) {
    const w = PART[k], d = D.DICT[w];
    label(`${esc(PARTZH[k])}<small>${esc(k === 'port' ? 'chōngdiànkǒu · chādiànshì' : d[0])}</small><em>${esc(k === 'port' ? 'charging port · plug-in' : d[1])}</em>`, 'part',
      () => W.car[k] && V3.add(W.car[k].worldPos(), [0, k === 'battery' ? -0.15 : 0.42, 0]), { show: () => ST.partLbl === k && ST.showLbl, click: () => openWord(w) });
  }
  label('王明 <span style="opacity:.75">Wáng Míng · 师傅</span>', 'name', () => W.wang.root.worldPos([0, 2.02, 0]));
  label('小龙 <span style="opacity:.8">Xiǎolóng · 学徒</span>', 'name dragon', () => W.dragon.root.worldPos([0, (W.dragon.height || 1.35) + 0.15, 0]), { show: () => W.dragon.root.visible });
  label('<span class="seal">语</span><small>语料库充电枪</small>', 'plaque', () => W.charger.plaque.worldPos(), { click: () => onCharger() });
  const CARN = { ice: ['燃油车', 'rányóuchē'], bev: ['纯电动汽车', 'chún diàndòng qìchē'], phev: ['插电式混合动力汽车', 'chādiànshì hùnhé dònglì qìchē'] };
  for (const k of ['ice', 'bev', 'phev']) label(`${CARN[k][0]}<small>${CARN[k][1]}</small>`, 'carname', () => W.show[k].root.worldPos([0, 1.85, 0]), { maxDist: 22, click: () => openWord(CARN[k][0]) });
  const stampL = label('质检 ✓', 'stamp', () => W.show.phev.root.worldPos([0.6, 1.7, 0.9]), { show: () => ST.stamp });
  // 搭配货架
  const SHELF = (LESSON?.assets?.shelf || (LESSON?.vocabulary || []).map((w, i) => ({ bay: i % 3, w, note: '本课词' }))).map(item => ({ ...item }));
  const bayCount = [0, 0, 0];
  const sr = () => W.shelf.root.pos;
  W.shelf.bays.forEach((b) => label(LESSON?.assets?.shelfBayNames?.[W.shelf.bays.indexOf(b)] || b.name, 'bayname', () => [sr()[0] + b.x, 2.62, sr()[2] + 0.3], { maxDist: 11 }));
  for (const t of SHELF) {
    const i = bayCount[t.bay]++, b = W.shelf.bays[t.bay];
    const y = [2.2, 1.86, 1.45, 1.1, 0.75][i] || 0.5;
    const o = label(`${esc(t.w)}${t.ev ? `<span class="seal sm" data-ev="${t.ev}">语</span>` : ''}<small>${esc(t.note)}</small>`, `tag${t.on ? ' corpus' : ''}${t.grey ? ' grey' : ''}`, () => [sr()[0] + b.x, y, sr()[2] + 0.34], { show: () => !t.on || ST.plugged, maxDist: 11, click: () => (t.ev && ST.plugged ? openEv(t.ev) : openWord(t.w)) });
    t.lbl = o;
  }

  // =========================================================== 声音
  let voices = [];
  const loadVoices = () => { try { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; } catch (e) { voices = []; } };
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  const zhVoice = () => { const available = voices.filter(v => NET?.enabled || v.localService); return available.find(v => /zh[-_](CN|Hans)/i.test(v.lang)) || available.find(v => /^zh/i.test(v.lang)) || null; };
  const voiceOutput = window.CDG_VOICE_OUTPUT.create({ voice: zhVoice, enabled: () => ST.sound });
  function speak(text, who) {
    return voiceOutput.play(String(text).replace(/[“”"‘’]/g, ''), who).finished.then(result => result.started && result.ended);
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  function browserMic() {
    cancelNpcReply('recording'); voiceOutput.stop();
    if (!SR) { toast('这个浏览器不支持语音识别：请打字（拼音也可以）或点选'); return; }
    if (rec) { try { rec.stop(); } catch (e) {} return; }
    let final = '';
    const startedAt = FLOW, prompt = askState;
    try {
      rec = new SR(); rec.lang = 'zh-CN'; rec.interimResults = true; rec.maxAlternatives = 1;
      const recognition = rec;
      rec.onresult = (e) => { if (rec !== recognition || !NET?.enabled || startedAt !== FLOW || prompt !== askState) return; let s = ''; for (const r of e.results) s += r[0].transcript; $('inp').value = s; if (e.results[e.results.length - 1].isFinal) final = s; };
      rec.onerror = (e) => toast(`语音识别没成功（${e.error}）：可以打字或点选`);
      rec.onend = () => { if (rec !== recognition) return; $('mic').classList.remove('rec'); rec = null; if (final && NET?.enabled && startedAt === FLOW && prompt === askState) { attemptSource = 'browser_asr'; speechResult = null; submit(final, false); toast('已识别文字；浏览器识别没有评测发音。'); } };
      rec.start(); $('mic').classList.add('rec');
    } catch (e) { rec = null; toast('语音识别启动失败：可以打字或点选'); }
  }
  function cancelCloudRecording() {
    micEpoch++; micBusy = false;
    if (cloudRecording) cloudRecording.capture.stop(true);
    cloudRecording = null; $('mic').classList.remove('rec'); $('mic').textContent = '🎤 说';
  }
  function practiceState(text = '') {
    if (!speechDialog) return;
    const m = speechDialog.m;
    m.querySelector('[data-practice-status]').textContent = text;
    m.querySelectorAll('[data-practice-drill], [data-practice-listen], [data-practice-submit]').forEach(b => { b.disabled = micBusy || !!cloudRecording; });
    const record = m.querySelector('[data-practice-record]');
    if (record) { record.disabled = micBusy; record.textContent = cloudRecording ? '停止并发送' : '再读一次'; record.classList.toggle('recording', !!cloudRecording); }
  }
  function showPronunciation(result, context) {
    const view = window.CDG_PRONUNCIATION.describe(result, context.target, LESSON?.vocabulary);
    if (!view.measured && !view.transcript) throw new Error('no_speech_evidence');
    let dialog = speechDialog;
    if (!dialog) {
      const m = modal('');
      dialog = speechDialog = { m, prompt: context.prompt, flow: context.flow, rootTarget: context.prompt?.cfg.speechTarget || '' };
      conversationOpen = true;
      m.querySelector('.box').setAttribute('role', 'dialog');
      m.querySelector('.box').setAttribute('aria-modal', 'true');
      m.querySelector('.box').setAttribute('aria-labelledby', 'practiceTitle');
      m.classList.add('pronunciation');
    }
    dialog.view = view; dialog.result = result; dialog.target = context.target;
    const drills = [...new Set([...view.drills, dialog.rootTarget].filter(Boolean))];
    const maySubmit = view.canSubmit && (!dialog.rootTarget || context.target === dialog.rootTarget);
    dialog.m.querySelector('.box').innerHTML = `<button class="close" data-x="1" aria-label="返回本题">×</button>
      <div class="practice-eyebrow">听 · 试 · 再说一次</div><h2 id="practiceTitle">${esc(view.title)}</h2>
      ${view.measured ? `<p class="practice-reference">${ruby(context.target)}</p>` : ''}
      ${view.score === null ? '' : `<p class="practice-score">发音参考 <b>${view.score}</b><small>自动评测，仅供练习</small></p>`}
      <div class="practice-feedback">${view.issues.map(issue => `<p><strong>${esc(issue.title)}</strong><span>${esc(issue.instruction)}</span><small>${esc(issue.en)}</small></p>`).join('') || `<p>${view.measured ? '这次可评测的声调没有发现差异。可以听示范，再读一遍。' : '请看一下，识别的文字对不对。'}</p>`}</div>
      ${view.transcript ? `<p class="practice-transcript">听到：<strong>${esc(view.transcript)}</strong></p>` : ''}
      ${drills.length ? `<div class="practice-drills" aria-label="选择跟读内容">${drills.map((s, i) => `<button type="button" data-practice-drill="${i}" aria-pressed="${s === context.target}">${esc(s)}</button>`).join('')}</div><div class="practice-actions"><button type="button" data-practice-listen>听示范</button><button type="button" data-practice-record>再读一次</button></div>` : ''}
      <p class="practice-status" data-practice-status role="status" aria-live="polite"></p><p class="practice-note">${esc(view.note)}</p>
      <div class="practice-footer">${maySubmit ? '<button type="button" data-practice-submit>用识别结果回答</button>' : ''}<button type="button" data-x="1">返回本题</button></div>`;
    dialog.m.querySelectorAll('[data-practice-drill]').forEach(b => { b.onclick = () => {
      dialog.target = drills[Number(b.dataset.practiceDrill)];
      dialog.m.querySelectorAll('[data-practice-drill]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      practiceState('跟读：' + dialog.target);
    }; });
    const listen = dialog.m.querySelector('[data-practice-listen]');
    if (listen) listen.onclick = async () => {
      const result = await voiceOutput.play(dialog.target, 'wang').finished;
      if (dialog === speechDialog && !micBusy && !cloudRecording && !(result.started && result.ended) && !['cancelled','superseded'].includes(result.reason)) practiceState('示范声音没有播放成功。可以照着拼音练习，或稍后再试。');
    };
    const record = dialog.m.querySelector('[data-practice-record]'); if (record) record.onclick = micToggle;
    const answer = dialog.m.querySelector('[data-practice-submit]');
    if (answer) answer.onclick = () => {
      if (dialog.prompt !== askState || dialog.flow !== FLOW || !NET.enabled) { closeModal(); return; }
      const transcript = view.transcript; closeModal(); speechResult = result; attemptSource = 'cloud_asr'; $('inp').value = transcript; submit(transcript, false); speechResult = null;
    };
    if (view.measured) track('pronunciation_attempt', { target: context.target, score: view.score, capability: 'L2' });
    (record || answer || dialog.m.querySelector('[data-x]')).focus();
  }
  async function micToggle() {
    if (micBusy) return;
    if (!askState) { toast('请在本题的跟读或作答时使用语音。'); return; }
    if (!NET?.enabled) { toast('当前为离线模式。可以打字、输入拼音或点选；使用联网语音请先开启“联机”。'); return; }
    if (!micConsent) {
      const m = modal(`<button class="close" data-x="1">×</button><h2>用语音练习</h2>${voiceNotice()}<button type="button" data-consent="1">同意本次语音练习</button>`);
      m.querySelector('[data-consent]').onclick = () => { micConsent = true; closeModal(); micToggle(); }; return;
    }
    if (!capabilities.asr && !capabilities.assessment) return browserMic();
    if (cloudRecording) {
      const context = cloudRecording; cloudRecording = null; const blob = context.capture.stop();
      $('mic').classList.remove('rec'); $('mic').textContent = '识别中…';
      if (!blob) { $('mic').textContent = '🎤 说'; practiceState('没有录到声音。可以再试一次，或返回本题。'); return; }
      const { prompt, flow, target, epoch } = context; micBusy = true; practiceState('正在听这次录音…');
      try {
        const form = new FormData(); form.append('audio', blob, 'speech.wav');
        for (const [k, v] of Object.entries({ mode: target ? 'read' : 'open', refText: target, lesson: lessonId(), level: ST.level, sessionId: NET.sessionId, station: ST.station || 'intro', step: currentStep })) form.append(k, String(v));
        const r = await NET.request('/api/speech/assess', form, 16000);
        if (epoch !== micEpoch || flow !== FLOW || prompt !== askState || !NET.enabled) return;
        if (!r.ok) throw new Error('speech_unavailable');
        showPronunciation(r, context);
      } catch (_) { if (NET.enabled && epoch === micEpoch && flow === FLOW && prompt === askState) {
        if (speechDialog) practiceState('这次没有可靠结果。可以重试，或返回本题打字、点选。');
        else { toast('云端语音暂不可用，改用浏览器识别；它只识别文字，不评发音。'); browserMic(); }
      } }
      finally { if (epoch === micEpoch) { micBusy = false; $('mic').textContent = '🎤 说'; practiceState(speechDialog?.m.querySelector('[data-practice-status]')?.textContent || ''); } }
      return;
    }
    micBusy = true;
    const flow = FLOW, prompt = askState, epoch = ++micEpoch, target = speechDialog?.target || prompt?.cfg.speechTarget || '';
    practiceState('正在打开麦克风…');
    try { cancelNpcReply('recording'); voiceOutput.stop();
      const capture = await window.CDG_SPEECH.start({ onLimit: () => micToggle() });
      if (epoch !== micEpoch || flow !== FLOW || prompt !== askState || !NET.enabled) { capture.stop(true); return; }
      cloudRecording = { capture, flow, prompt, target, epoch }; $('mic').classList.add('rec'); $('mic').textContent = '停止并发送';
    } catch (_) { if (epoch === micEpoch) { toast('无法打开录音。可继续打字、输入拼音或点选。'); practiceState('麦克风未打开。可以重试或返回本题。'); } }
    finally { if (epoch === micEpoch) { micBusy = false; practiceState(cloudRecording ? '正在录音；读完后点“停止并发送”。' : ''); } }
  }

  // =========================================================== 字幕
  function tokClass(t) {
    // Professional vocabulary is still above the selected general-language level.
    // A lesson tag must never hide that distinction.
    if (t.over) return 'll-new';
    if (t.tag === 'm') return 'll-name';
    if (t.tag === 'g') return 'll-gram';
    if (['n', 'r', 'x'].includes(t.tag)) return 'll-lesson';
    return '';
  }
  function ruby(zh) {
    return wordTokens(zh).map((t) => t.zh ? `<ruby class="${tokClass(t)}" data-w="${esc(t.t)}" title="${esc(t.en || S.dialogueGloss?.[t.t] || '')}">${esc(t.t)}<rt>${esc(t.py || S.dialoguePinyin?.[t.t] || '')}</rt></ruby>` : `<span class="ll-plain">${esc(t.t)}</span>`).join('');
  }
  function gloss(zh) {
    const words = new Map();
    for (const t of wordTokens(zh)) if (t.zh && t.over) words.set(t.t, t.en || S.dialogueGloss?.[t.t] || 'meaning not yet checked');
    return [...words].map(([w, en]) => `<span>${esc(w)} · ${esc(en)}</span>`).join('');
  }
  const WHO = { wang: '王明 · 师傅', dragon: '小龙 · 学徒', you: '你 · 马丁' };
  let capText = '', capWhoK = 'wang';
  function showCap(who, zh, en, o = {}) {
    capText = zh; capWhoK = who;
    $('cap').classList.remove('hidden'); $('cap').classList.toggle('reply', !!o.reply);
    $('capWho').textContent = WHO[who] || who; $('capWho').className = 'll-cap-who' + (who === 'dragon' ? ' dragon' : '');
    $('capLv').textContent = `目标 HSK ${ST.level}`;
    $('capLine').innerHTML = ruby(zh); $('capEn').textContent = en || '';
    if ($('capGloss')) $('capGloss').innerHTML = gloss(zh);
    $('capSeal').innerHTML = o.seal ? `<span class="seal sm cap-seal" data-ev="${o.seal}" title="这句话的依据">语</span>` : '';
    if (o.seal) ST.ev.add(o.seal);
  }
  $('capLine').addEventListener('click', (e) => { const r = e.target.closest('ruby'); if (r) openWord(r.dataset.w); });
  $('capSay').onclick = () => capText && speak(capText, capWhoK);

  // =========================================================== 流程控制
  let FLOW = 0; const CANCEL = { cancel: true };
  const chk = (id) => { if (id !== FLOW) throw CANCEL; };
  let sayResolve = null;
  async function say(id, who, line, o = {}) {
    chk(id);
    showCap(who, line.zh, line.en, o);
    setTeacher(line.teacher);
    if (o.compare) setCompare(o.compare);
    $('capNext').classList.remove('hidden');
    const t0 = performance.now(), minT = (AUTO && AUTO.fast) ? 60 : 1100 + line.zh.length * 150;
    let ttsDone = false; speak(line.zh, who).then(() => { ttsDone = true; });
    if (!ST.sound) ttsDone = true;
    await new Promise((res) => {
      const finish = () => { if (sayResolve === finish) { sayResolve = null; res(); } };
      sayResolve = finish;
      $('capNext').onclick = finish;
      const tick = () => { if (sayResolve !== finish) return; if (!conversationOpen && (ttsDone || (AUTO && AUTO.fast)) && performance.now() - t0 > minT) finish(); else setTimeout(tick, 120); };
      setTimeout(tick, 150);
    });
    $('capNext').classList.add('hidden');
    chk(id);
  }
  let askState = null;
  function ask(id, cfg) {
    chk(id);
    cancelNpcReply('new_prompt');
    if (!cfg.speechTarget && cfg.stage === '认' && String(cfg.task).startsWith('跟读')) cfg.speechTarget = cfg.answer || '';
    currentStep = cfg.step || `${ST.station || 'intro'}-prompt-${++promptSerial}`;
    track('prompt_shown', { target: cfg.speechTarget || cfg.answer || '', task: cfg.task || '' });
    return new Promise((resolve) => { askState = { id, cfg, resolve, tries: 0, hint: 0, coachingHistory: [] }; showInbar(cfg); }).then((v) => { chk(id); return v; });
  }
  function showInbar(cfg) {
    $('inbar').classList.remove('hidden');
    $('task').innerHTML = `${cfg.stage ? `<span class="stage">${esc(cfg.stage)}</span>` : ''}<span>${esc(cfg.task || '')}</span>`;
    const chips = (cfg.options || []).map((o) => `<button type="button" data-chip="${esc(o)}">${esc(o)}${cfg.optEn && cfg.optEn[o] ? `<small>${esc(cfg.optEn[o])}</small>` : ''}</button>`);
    for (const ex of cfg.examples || []) chips.push(`<button type="button" data-fill="${esc(ex)}" title="填进输入框，可以修改">${esc(ex)}<small>example · 点一下填入</small></button>`);
    $('chips').innerHTML = chips.join('');
    $('inp').value = ''; $('msg').textContent = ''; $('msg').className = 'msg'; $('hintline').textContent = '';
    $('form').style.display = cfg.noInput ? 'none' : '';
    $('hint').style.display = cfg.answer ? '' : 'none';
    if (!cfg.noInput && !('ontouchstart' in window)) { const prompt = askState, flow = FLOW; setTimeout(() => { if (askState === prompt && FLOW === flow && !conversationOpen && !document.querySelector('.modal')) $('inp').focus(); }, 60); }
    stackBottom();
    if (AUTO && AUTO.answers && AUTO.answers.length) { const a = AUTO.answers.shift(); setTimeout(() => submit(a, /^(#|✓|🔌|先不插)/.test(a) || (cfg.options || []).includes(a)), AUTO.gap || 300); }
  }
  function hideInbar() { $('inbar').classList.add('hidden'); stackBottom(); }
  // 底部三层按实际高度往上叠：输入条有提示、反馈多行时会长高，字幕和接头板跟着上移，不被压住
  function stackBottom() {
    const ib = $('inbar'), cp = $('cap'), de = document.documentElement, rs = de && de.style;
    if (!rs || !rs.setProperty) return;
    const inH = ib.classList.contains('hidden') ? 0 : (ib.offsetHeight || 0);
    const capB = inH ? Math.max(128, 14 + inH + 8) : 128;
    const capH = cp.classList.contains('hidden') ? 0 : (cp.offsetHeight || 0);
    rs.setProperty('--cap-b', capB + 'px');
    rs.setProperty('--board-b', Math.max(236, capB + (capH ? capH + 8 : 0)) + 'px');
    const top = $('topbar'), teacher = $('teacher');
    const topBottom = top.classList.contains('hidden') ? 54 : 10 + (top.offsetHeight || 44);
    const teacherHeight = teacher.classList.contains('hidden') ? 0 : (teacher.offsetHeight || 0);
    rs.setProperty('--topbar-b', topBottom + 'px');
    rs.setProperty('--feedback-top', (topBottom + teacherHeight + 16) + 'px');
  }
  if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(() => stackBottom()); for (const id of ['inbar','cap','topbar','teacher']) ro.observe($(id)); }
  addEventListener('resize', () => stackBottom());

  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.fill != null) { $('inp').value = b.dataset.fill; $('inp').focus(); return; }
    submit(b.dataset.chip, true);
  });
  $('form').addEventListener('submit', (e) => { e.preventDefault(); submit($('inp').value, false); });
  $('mic').onclick = micToggle;
  $('hint').onclick = () => {
    const A = askState; if (!A || !A.cfg.answer) return;
    const a = A.cfg.answer, steps = A.cfg.hints || [`拼音 · ${L.pinyinOf(a)}`, `答案 · ${a}`];
    $('hintline').textContent = steps[Math.min(A.hint, steps.length - 1)]; A.hint++;
    ST.hints++; gauges();
    track('hint_used', { attempt: A.tries + 1, target: A.cfg.answer });
    if (A.hint >= steps.length && !$('chips').querySelector('.answer')) $('chips').insertAdjacentHTML('beforeend', `<button type="button" class="answer" data-chip="${esc(a)}">${esc(a)}<small>点这里也可以</small></button>`);
  };
  function submit(text, chip) {
    const submittedAt = performance.now();
    if (conversationOpen) return;
    const A = askState; if (!A) return;
    const t = String(text || '').trim(); if (!t) return;
    if (cloudRecording || micBusy) cancelCloudRecording();
    if (/asr/.test(attemptSource) && !chip) ST.spoken++;
    if (chip && /^✓ 我读了/.test(t)) ST.selfReported++;
    if (!chip || !/^(✓|跳过|先不插)/.test(t)) ST.responses++;
    gauges();
    let r = {};
    try { r = A.cfg.check(t, chip, { inputMode: attemptSource.replace('_', '-') }) || {}; } catch (e) { console.error(e); r = { ok: false }; }
    track('answer', { transcript: t, correct: !!r.ok, attempt: A.tries + 1, target: A.cfg.answer || '', inputMode: chip ? 'choice' : attemptSource });
    if (!chip && /asr/.test(attemptSource)) track('speak_attempt', { transcript: t, asrOk: true, score: speechResult?.overall ?? null, attempt: A.tries + 1, issues: speechResult?.issues || [], inputMode: attemptSource });
    attemptSource = 'text';
    if (r.ok) {
      $('msg').className = 'msg ok'; $('msg').innerHTML = r.msg ? esc(r.msg) + (r.seal ? ` <span class="seal sm" data-ev="${r.seal}">语</span>` : '') : '✓';
      if (r.seal) ST.ev.add(r.seal);
      askState = null; closeFix();
      setTimeout(() => { if (!askState) hideInbar(); }, 650);
      A.resolve({ text: t, r });
    } else {
      A.tries++;
      $('msg').className = 'msg'; $('msg').innerHTML = esc(r.msg || '再试一次 · Try again') + (r.seal ? ` <span class="seal sm" data-ev="${r.seal}">语</span>` : '');
      if (r.seal) ST.ev.add(r.seal);
      if (r.fix && r.fix.sugs && r.fix.sugs.length) showFix(r.fix.was || t, r.fix.sugs);
      if (A.tries >= 2 && A.cfg.answer && !A.cfg.noAnswerChip && !$('chips').querySelector('.answer')) $('chips').insertAdjacentHTML('beforeend', `<button type="button" class="answer" data-chip="${esc(A.cfg.answer)}">${esc(A.cfg.answer)}<small>可以照着说 · say this</small></button>`);
      $('inp').value = '';
      void coachAttempt(A, t, r, submittedAt);
      if (AUTO && AUTO.answers && AUTO.answers.length) { const a = AUTO.answers.shift(); setTimeout(() => submit(a, /^(#|✓|🔌|先不插)/.test(a) || (A.cfg.options || []).includes(a)), AUTO.gap || 300); }
    }
  }
  async function coachAttempt(A, text, localResult, submittedAt) {
    if (!NET?.enabled || !capabilities.npc || !A.cfg.step) return;
    const flow = FLOW, tries = A.tries, role = ST.station === 'd' ? 'dragon' : 'wang';
    const fallback = { zh: localResult.msg || '先看提示，再试一次。', en: '' };
    const reply = beginNpcReply(role, 'feedback', () => flow === FLOW && askState === A && A.tries === tries && NET.enabled && !conversationOpen, text => {
      // Keep the local correction visible; the thinking line is only a removable extra.
      const node = document.createElement('div'); node.className = 'npc-waiting';
      node.innerHTML = `${ruby(text)}<div class="cap-gloss">${gloss(text)}</div><small>Let me think.</small>`;
      $('hintline').append(node); return () => node.remove();
    }, submittedAt);
    const result = await NET.turn({ ...turnContext(text, role), purpose: 'feedback', focus: ST.focus, attempt: tries, history: A.coachingHistory.slice(-6) }, fallback);
    if (!reply.received(result)) return;
    // Coaching cannot resolve the prompt, alter the local verdict, or add an evidence seal.
    const line = document.createElement('div'); line.className = 'npc-coaching';
    line.innerHTML = `<b>${role === 'dragon' ? '小龙' : '王明'}</b> ${ruby(result.zh)}<div class="cap-gloss">${gloss(result.zh)}</div>${result.en ? `<small>${esc(result.en)}</small>` : ''}`;
    $('hintline').replaceChildren(line);
    A.coachingHistory.push({ who: 'you', zh: text }, { who: role, zh: result.zh });
    if (A.coachingHistory.length > 6) A.coachingHistory.splice(0, A.coachingHistory.length - 6);
    reply.present(result);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && (speechDialog || npcDialog)) {
      const dialog = speechDialog || npcDialog;
      const buttons = [...dialog.m.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter(el => el.getClientRects().length);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.m.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.m.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    }
    if (e.key === 'Escape') { if (modal2El) { modal2El.remove(); modal2El = null; } else { closeCard(); closeModal(); } }
    if (e.code === 'Space' && document.activeElement !== $('inp') && sayResolve && !document.querySelector('.modal')) { e.preventDefault(); sayResolve(); }
  });
  function gauges() {
    $('gB').style.width = Math.min(100, ST.spoken * 4) + '%'; $('gBt').textContent = `开口 ${ST.spoken} 次`;
    $('gF').style.width = Math.max(0, 100 - ST.hints * 10) + '%'; $('gFt').textContent = `提示 ${ST.hints} 次`;
  }

  // =========================================================== 词卡
  let cardWord = '';
  const TAGNAME = { n: '生词', r: '复习词', x: '课本词', g: '语法点', t: '教学用语' };
  function chainFor(w) {
    const seen = new Set([w]), out = [];
    const OK = new Set(['电', '机', '车', '油']);
    for (const ch of w) if ([...w].length === 1 || OK.has(ch)) for (const c of H.chain[ch] || []) if (!seen.has(c[0])) { seen.add(c[0]); out.push(c); }
    return out.sort((a, b) => (LEXICON.entry(a[0])?.maxLevel || 99) - (LEXICON.entry(b[0])?.maxLevel || 99)).slice(0, 6);
  }
  const sealH = (ev) => (ev ? `<span class="seal sm" data-ev="${ev}" title="看出处">语</span>` : '');
  function evSrc(ev) { const e = D.EV[ev]; return e ? `${D.CH[e.ch]} · ${e.src}` : ''; }
  function openWord(w) {
    if (!w) return;
    track('word_card_open', { word: w });
    cardWord = w;
    let card = $('card'); if (!card) { card = document.createElement('div'); card.id = 'card'; card.className = 'll-card'; document.body.append(card); card.addEventListener('click', onCardClick); }
    const d = lexiconOptions.dictionary[w] || null, entry = LEXICON.entry(w), legacy = H.w[w] || null; let c = D.CARD[w]; if (c && c.alias) c = D.CARD[c.alias];
    const lesson = d && ['n', 'r', 'x', 'g', 't'].includes(d[2]);
    const above = !ST.teacher && (!entry || entry.maxLevel > ST.level);
    let badges = '';
    if (lesson) badges += `<span class="ll-badge lesson">本课${TAGNAME[d[2]]}</span>`;
    if (lexiconOptions.professionalWords.includes(w)) badges += '<span class="ll-badge lesson">课程专业词</span>';
    if (entry) badges += `<span class="ll-badge${above ? ' ll-up' : ''}">${esc(entry.label)}</span>`;
    else badges += '<span class="ll-badge ll-up">HSK 词汇表未收录</span>';
    const py = (d && d[0]) || entry?.readings.join(' / ') || S.dialoguePinyin?.[w] || '', mean = (d && d[1]) || entry?.meanings.join('; ') || S.dialogueGloss?.[w] || '';
    const tb = c && c.tb;
    let h = `<div class="ll-card-head"><div><div class="ll-card-hz">${esc(w)}${badges}</div><div class="ll-card-py">${esc(py)} <button type="button" class="ll-mini" data-say="${esc(w)}" style="border:1px solid rgba(58,46,40,.16);background:#fff;border-radius:99px;padding:2px 8px;cursor:pointer">🔊</button></div></div><button type="button" class="ll-card-close" data-close="1" aria-label="Close">×</button></div>
      <p class="ll-card-mean" lang="en">${esc(mean)}</p>`;
    if (lesson && above) h += `<div class="ll-sec" style="border:0;padding-top:0;margin-top:8px"><div class="lock" style="border-style:solid;border-color:rgba(178,58,46,.25);background:rgba(178,58,46,.05);color:#6b2a22">本课目标词：${entry ? esc(entry.label) : 'HSK 词汇表未收录'}。当前目标为 HSK ${ST.level}，课堂提供拼音、英语与动作支持；这不代表全文严格符合该等级。</div></div>`;
    if (entry?.ambiguous) h += '<div class="pending">同一词形有不同等级的用法。尚未逐句判定词义，当前按最高可能等级提示；拼音与英文列出可能项，不能代替本句解释。</div>';
    if (c?.authored) h += `<div class="ll-sec"><h4>${esc(c.authored.label || '自编样例，待教师审阅')}</h4><div class="ll-ex-zh">${esc(c.authored.ex)}</div></div>`;
    if (tb || (d && d[3] && !c?.authored && LESSON?.textbook)) h += `<div class="ll-sec"><h4>课本 · Textbook</h4>${tb ? `<div class="ll-ex-zh">${esc(tb.ex)} <button type="button" class="ll-mini" data-say="${esc(tb.ex)}" style="border:0;background:transparent;cursor:pointer">🔊</button></div><div class="ll-ex-py">${esc(L.pinyinOf(tb.ex))}</div><div class="ll-ex-en">${esc(tb.exEn)}</div>` : ''}<div class="ll-ex-en" style="margin-top:4px">${esc((tb && tb.page) || ('课本 ' + d[3]))}</div></div>`;
    if (legacy && legacy[3]) h += `<div class="ll-sec"><h4>Example · 补充例句（第三方资料）</h4><div class="ll-ex-zh">${esc(legacy[3])}</div><div class="ll-ex-py">${esc(legacy[4])}</div><div class="ll-ex-en">${esc(legacy[5])}</div></div>`;
    const ch = chainFor(w);
    if (ch.length) h += `<div class="ll-sec"><h4>共字拓展 · 不代表词源或先修关系</h4><div class="ll-chips">${ch.map((x) => `<button type="button" class="ll-chip" data-word="${esc(x[0])}" style="cursor:pointer"><b>${esc(x[0])}</b><em>${esc(LEXICON.entry(x[0])?.label || 'HSK 词汇表未收录')}</em><small>${esc(x[2])} · ${esc(x[3])}</small></button>`).join('')}</div></div>`;
    // 四栏
    if (!ST.plugged) {
      h += `<div class="ll-sec"><h4>语料 · 常见搭配 · 常见偏误 · 易混词</h4><div class="lock">🔌 <b>还没插电。</b>插上车间里的语料库充电枪，这里显示：教材和视频里的真实例句、搭配出现的次数、学习者真实写错的句子、容易混的词——每一条都能点开看出处。<br><span class="pending">提供包标注了检索时间与出处；插电不会发起实时网络查询。</span></div></div>`;
    } else if (c && c.graph) {
      const g = c.graph, used = [];
      const sec = (title, inner) => `<div class="ll-sec"><h4>${title}</h4>${inner}</div>`;
      if (g.corpus && g.corpus.length) h += sec('From the corpus · 语料', `<ul class="ll-list">${g.corpus.map((x) => { used.push(x.ev); return `<li><span class="ll-tag">${esc(x.tag)}</span><span class="ll-zh">${esc(x.zh)}</span>${sealH(x.ev)}<small>${esc(evSrc(x.ev))}</small></li>`; }).join('')}</ul>`);
      if (g.collocations && g.collocations.length) h += sec('Goes with · 常见搭配', `<div class="ll-chips">${g.collocations.map((x) => { used.push(x.ev); return `<span class="ll-chip${x.grey ? ' grey' : ''}"><b>${esc(x.w)}</b>${x.n ? `<em>${x.n} 次</em>` : ''}${sealH(x.ev)}${x.grey ? '<small>新闻用语 · 超纲</small>' : ''}</span>`; }).join('')}</div>`);
      if (g.errors && g.errors.length) h += sec('Common mistakes · 常见偏误（学习者作文）', `<ul class="ll-list">${g.errors.map((x) => { used.push(x.ev); return `<li><span class="ll-zh ll-bad">${esc(x.wrong)}</span> → <span class="ll-zh ll-good">${esc(x.right)}</span>${sealH(x.ev)}<small>${esc(x.note)}</small></li>`; }).join('')}</ul>`);
      else h += sec('Common mistakes · 常见偏误', '<div class="pending">当前离线包没有可展示的典型偏误，不另行编造。</div>');
      if (g.confusables && g.confusables.length) h += sec('Easy to mix up · 易混词', `<ul class="ll-list">${g.confusables.map((x) => { used.push(x.ev); return `<li><span class="ll-zh">${esc(x.word)}</span> <span class="ll-ex-py">${esc(x.pinyin)}</span>${sealH(x.ev)}<small>${esc(x.diff)}</small></li>`; }).join('')}</ul><div class="pending" style="margin-top:4px">易混词的系统辨析待接入知识图谱；这里只列教材和语料里能证明的。</div>`);
      used.filter(Boolean).forEach((e) => ST.ev.add(e));
    } else {
      h += `<div class="ll-sec"><h4>语料 · 常见搭配 · 常见偏误 · 易混词</h4><div class="pending">这个词还没有打包进离线语料包（原型只打包了本课重点词）。正式版接语料库接口后实时查询。</div></div>`;
    }
    h += `<div class="ll-sec"><h4>HSK 考题 · Exam items</h4><div class="lock">待接入：考题库权限开通后，这里显示同一个词、同一个语法点在 HSK 真题里怎么考。</div></div>`;
    card.innerHTML = h;
  }
  function onCardClick(e) {
    const s = e.target.closest('[data-say]'); if (s) return speak(s.dataset.say, 'wang');
    const w = e.target.closest('[data-word]'); if (w) return openWord(w.dataset.word);
    if (e.target.closest('[data-close]')) closeCard();
  }
  function closeCard() { const c = $('card'); if (c) c.remove(); cardWord = ''; }

  // 出处（点任意“语”字印章）
  document.addEventListener('click', (e) => { const s = e.target.closest('[data-ev]'); if (s) { e.stopPropagation(); openEv(s.dataset.ev); } }, true);
  function openEv(id) {
    track('evidence_open', { evidenceId: id });
    const ev = D.EV[id]; if (!ev) return;
    ST.ev.add(id);
    let rows = `<tr><th>库</th><td>${esc(D.CH[ev.ch])}</td></tr><tr><th>检索式</th><td>${esc(ev.q)}</td></tr>`;
    if (ev.hits != null) rows += `<tr><th>命中</th><td>${esc(ev.hits)} 条</td></tr>`;
    rows += `<tr><th>原文</th><td class="zh">${esc(ev.zh)}</td></tr>`;
    if (ev.raw) rows += `<tr><th>标注原文</th><td><div class="raw">${esc(ev.raw)}</div></td></tr>`;
    rows += `<tr><th>出处</th><td>${esc(ev.src)}</td></tr>`;
    if (ev.note) rows += `<tr><th>说明</th><td>${esc(ev.note)}</td></tr>`;
    rows += `<tr><th>检索时间</th><td>${esc(ev.at)}</td></tr>`;
    let extra = '';
    if (ev.list === 'ye20') extra = `<h3 style="font:600 14px var(--ll-font);margin:14px 0 6px">全部 20 条（按出现顺序）</h3><table><tr><th style="width:36px">类</th><th style="width:auto">语料原文（含偏误标注，{CJX}=语序错误）</th><th style="width:110px">国籍/分数/等级</th></tr>${D.YE20.map((r) => `<tr><td><span class="cat ${r[2]}">${r[2]}</span></td><td><div class="raw">${esc(r[0])}</div></td><td>${esc(r[1])}</td></tr>`).join('')}</table><div class="note">A = “也”在分句开头或主语前（15 处）；B = “也”在主语后、但在状语前，应放到状语后面（5 处）。归类规则：看“也”后面紧跟的成分。</div>`;
    modal2(`<button class="close" data-x="1">×</button><h2><span class="seal">语</span>语料出处</h2><div class="sub">国际中文教育语料库 · 官方接口实测，离线打包</div><table>${rows}</table>${extra}<div class="note">学习者语料来自 HSK 动态作文语料，含偏误，只作证据，不能当规范范例；命中数只代表本次检索在该库匹配到多少条，不同库之间不能直接比大小。</div>`);
  }
  let modalEl = null, modal2El = null;
  function modal2(html) { if (modal2El) modal2El.remove(); modal2El = document.createElement('div'); modal2El.className = 'modal'; modal2El.style.zIndex = 86; modal2El.innerHTML = `<div class="box">${html}</div>`; modal2El.addEventListener('click', (e) => { if (e.target === modal2El || e.target.closest('[data-x]')) { modal2El.remove(); modal2El = null; } }); document.body.append(modal2El); return modal2El; }
  function modal(html) { closeModal(); modalEl = document.createElement('div'); modalEl.className = 'modal'; modalEl.innerHTML = `<div class="box">${html}</div>`; modalEl.addEventListener('click', (e) => { if (e.target === modalEl || e.target.closest('[data-x]')) closeModal(); }); document.body.append(modalEl); return modalEl; }
  function closeModal() { cancelNpcReply('dialog_closed'); if (npcDialog) { const old = npcDialog; npcDialog = null; old.voice?.cancel(); voiceOutput.stop(); $('inp').focus(); } if (speechDialog) { speechDialog = null; cancelCloudRecording(); voiceOutput.stop(); $('inp').focus(); } if (modalEl) modalEl.remove(); modalEl = null; conversationOpen = false; }

  // 纠错卡（≤2 条建议，重写整句）
  let fixEl = null;
  function closeFix() { if (fixEl) fixEl.remove(); fixEl = null; document.body.classList.remove('fixing'); }
  function showFix(was, sugs) {
    closeFix();
    const target = sugs[sugs.length - 1].sentence;
    let w = esc(was); for (const s of sugs) if (s.wrong && was.includes(s.wrong)) w = w.replace(esc(s.wrong), `<mark>${esc(s.wrong)}</mark>`);
    fixEl = document.createElement('div'); fixEl.className = 'll-fix'; document.body.classList.add('fixing');
    fixEl.innerHTML = `<h4>Try once more · 再写一次</h4><div class="ll-was">${w}</div>${sugs.map((s) => `<div class="ll-now">${esc(s.right)} <small class="ll-now-py">${esc(s.rightPinyin || '')}</small></div><div class="ll-why">${esc(s.why)}</div>${s.evNote ? `<div class="ll-evi">${esc(s.evNote)} ${sealH(s.ev)}</div>` : ''}`).join('')}
      ${target ? `<form><input type="text" autocomplete="off" placeholder="把整句再写一遍 · Type the whole sentence again" /><button type="submit">OK</button><button type="button" class="ll-skip">Skip</button></form>` : '<form><button type="button" class="ll-skip">OK</button></form>'}`;
    sugs.forEach((s) => s.ev && ST.ev.add(s.ev));
    fixEl.querySelector('.ll-skip').onclick = closeFix;
    const f = fixEl.querySelector('form');
    f.addEventListener('submit', (e) => {
      e.preventDefault(); const inp = f.querySelector('input'); if (!inp) return;
      if (L.norm(inp.value) === L.norm(target)) {
        fixEl.classList.add('ll-done'); fixEl.innerHTML = `<div class="ll-ok">很好！That's right. ✓</div><div class="ll-was">${esc(target)}</div>`;
        speak(target, 'wang'); const done = fixEl; setTimeout(() => { if (fixEl === done) closeFix(); }, 2200);
        if (askState) submit(target, false);
      } else { inp.value = ''; inp.placeholder = target; inp.focus(); }
    });
    document.body.append(fixEl);
  }

  // =========================================================== 对照面板 / 教师提示 / 提示条
  let curCmp = null;
  function setCompare(c) { curCmp = c; renderCompare(); }
  function renderCompare() {
    const el = $('compare');
    if (!ST.compare) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const c = curCmp;
    const col = (side, x) => x ? `<div class="col ${side}"><b>${side === 'off' ? '未插电 · 仅教材 + 设计者经验' : '已插电 · 语料库实证'}</b><div class="zh">${esc(x.zh)}</div><span class="src">${esc(x.src || '')} ${side === 'on' ? sealH(x.ev) : ''}</span></div>` : '';
    el.innerHTML = `<h3>插电前后对照 · 当前一步 <button type="button" data-cmpx="1">×</button></h3>${c ? `<div class="title">${esc(c.title)}</div><div class="cols">${col('off', c.off)}${col('on', c.on)}</div>` : '<div class="title" style="padding-bottom:12px">往下走，每一步插电前后的差别会并排显示在这里。</div>'}`;
    if (c && c.on && c.on.ev && ST.plugged) ST.ev.add(c.on.ev);
  }
  $('compare').addEventListener('click', (e) => { if (e.target.closest('[data-cmpx]')) { ST.compare = false; syncTools(); renderCompare(); } });
  function setTeacher(t) { const el = $('teacher'); if (!ST.teacher || !t) el.classList.add('hidden'); else { el.classList.remove('hidden'); el.innerHTML = `<b>老师</b>${esc(t)}`; } stackBottom(); }
  let toastT = null;
  function toast(msg, cls = '') { let el = $('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); } el.className = 'toast ' + cls; el.innerHTML = msg; el.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => { el.style.opacity = 0; }, 3600); }

  // =========================================================== 插电
  async function setPlugged(on, animate = true) {
    if (ST.plugged === on) return;
    ST.plugged = on; if (on) ST.everPlugged = true; W.charger.plugged = on;
    track('plug_toggle', { plugged: on });
    document.body.classList.toggle('plugged', on);
    $('plugTxt').textContent = on ? '已插电 · 语料库' : '未插电 · 仅教材';
    $('modeTag').innerHTML = on ? '已插电：展示本课语料快照。点 <span class="seal sm" style="cursor:default">语</span> 看出处' : '未插电：固定课堂内容';
    const ch = W.charger, port = W.car.port.worldPos([0, 0, 0.16]);
    const from = [...ch.gun.pos], to = on ? port : [...ch.holster], mid = V3.add(V3.lerp(from, to, 0.5), [0, 0.7, 0]);
    ch.gun.rot = on ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    if (animate) await E.tween(0.9, (k) => { ch.gun.pos = WD.bez(from, mid, to, k); ch.updateCable(); });
    ch.gun.pos = to; ch.updateCable();
    for (const l of W.lamps) l.emis = on ? hex('#9a8a62') : hex('#5a5240');
    for (const w of W.windows) w.emis = on ? hex('#7a6e55') : hex('#5d5545');
    R.env.bright = on ? 1.05 : 0.95;
    ch.plaque.emis = on ? [0.55, 0.16, 0.08] : [0, 0, 0];
    W.car.portGlow.emis = on ? [0.15, 0.4, 0.7] : [0, 0, 0];
    W.car.flows.charge.on = on;
    if (cardWord) openWord(cardWord);
    renderCompare();
    toast(on ? '<span class="seal sm" style="cursor:default">语</span> 已开启本课语料快照；只有已提供的证据才会显示' : '已关闭语料扩展，继续固定课堂', on ? 'zhu' : '');
  }
  function onCharger() {
    if (askState && askState.cfg.plugAction) return submit('🔌 插电', true);
    setPlugged(!ST.plugged);
  }
  $('plug').onclick = () => onCharger();
  function onTap(x, y) {
    if (AUTO && !AUTO.tap) return;
    const hit = R.pick(cam, x, y); if (!hit) return;
    if (hit.pick === 'charger') return onCharger();
    if (PART[hit.pick]) openWord(PART[hit.pick]);
  }

  // ---- 工具栏 ----
  function syncTools() {
    for (const b of $('tools').querySelectorAll('button[data-t]')) { const k = b.dataset.t; if (k in ST) b.setAttribute('aria-pressed', String(!!ST[k])); }
    document.body.classList.toggle('nopy', !ST.py); document.body.classList.toggle('noen', !ST.en);
  }
  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    const k = b.dataset.t;
    if (k === 'about') return about();
    if (k === 'scene') return toggleScenePanel();
    if (k === 'online') return toggleOnline();
    if (k === 'ask') return askMaster();
    if (k === 'character') return chooseCharacter();
    if (k === 'dashboard') { if (/^https?:$/.test(location.protocol)) window.open('/teacher.html', '_blank', 'noopener'); else toast('课堂概览需要本机服务。当前离线课堂可以继续。'); return; }
    ST[k] = !ST[k]; syncTools();
    if (k === 'compare') renderCompare();
    if (k === 'teacher') setTeacher(null);
    if (k === 'sound' && !ST.sound) voiceOutput.stop();
  });

  // =========================================================== 场景动作
  function setXray(on) { WD.setXray(W.car, on); }
  function act(part) {
    if (part === 'battery') { const b = W.car.battery, y0 = 0.4; E.tween(0.5, (k) => { b.pos[1] = y0 - 0.08 * Math.sin(k * Math.PI); }); flows(W.car, { elec: true }); anim.wheels = 1.6; setTimeout(() => flows(W.car, { elec: false }), 1800); }
    if (part === 'motor') { anim.motor = 2.2; flows(W.car, { elec: true }); anim.wheels = 2.2; setTimeout(() => flows(W.car, { elec: false }), 2200); }
    if (part === 'engine') { anim.shake = 1.6; flows(W.car, { fuel: true }); anim.wheels = 1.6; setTimeout(() => flows(W.car, { fuel: false }), 1800); }
  }
  function sparksAtCar() { W.sparks.burst(W.car.root.worldPos([1.45, 0.62, 0.05])); }
  async function walk(node, to, dur) {
    const from = [...node.pos]; WD.face(node, to);
    await E.tween(dur, (k) => { node.pos = V3.lerp(from, to, k); }, E.ease.inOut);
  }
  function placeWang(where) {
    const w = W.wang.root;
    if (where === 'lift') { w.pos = [3.7, 0, 0.5]; WD.face(w, [2, 0, 4]); }
    if (where === 'show') { w.pos = [...LAY.wangShow]; WD.face(w, LAY.kind === 'code' ? [20, 0, 6.5] : [11 + LAY.showDx, 0, 1]); }
  }
  function point(on) { W.wang.armR.rot[2] = on ? 1.35 : 0; }

  // =========================================================== 题目检查
  const confirmCheck = (t, it) => {
    const r = L.judgeConfirm(t, it.truth, it.fixes);
    if (r.ok) return { ok: true, msg: it.truth ? '对！' : '对，说得很完整。' };
    if (r.why === 'needFix') return { ok: false, msg: '“不是，……”——请把对的说出来。 · Say what is right.' };
    if (r.why === 'wrongPos') return { ok: false, msg: '再看看车：真的是这样吗？' };
    if (r.why === 'wrongNeg') return { ok: false, msg: '再想想：这句话是对的。' };
    return { ok: false, msg: '回答“对。”或者“不是，……”。' };
  };
  function yeFeedback(r, it) {
    const plugged = ST.plugged;
    const fixSent = r.sentence && r.slot < 0 && r.cat !== 'none' ? L.fixYeSentence(r.sentence) : L.yeItemText(it, it.ok);
    const sugKind = { A: 'A', END: 'END', B: 'B' }[r.cat];
    const fix = r.slot < 0 && sugKind ? { was: r.sentence, sugs: L.suggest(sugKind, { wrong: '也', right: L.yeItemText(it, it.ok), sentence: L.yeItemText(it, it.ok) }, plugged) } : null;
    if (!plugged) return { msg: '不对，再试一次。“也”用在动词前。 · 也 goes right before the verb.', fix };
    if (r.cat === 'A') return { msg: '你把“也”放在了主语前面。很多同学都这样错：抽查 20 处，15 处和你一样。“也”要紧挨着动词。', seal: 'ln-ye-stat', fix };
    if (r.cat === 'END') return { msg: '句尾不放“也”。（语料：397 处“也”语序偏误里，紧挨句号的 0 处——这不是常见错误，多半是不小心。）', seal: 'ln-ye-end', fix };
    if (r.cat === 'B') return { msg: '“也”放在动词前，状语后。语料里这是第二常见的错法（20 处中 5 处）。', seal: 'ln-ye-3', fix };
    if (r.cat === 'first') return { msg: '这是第一句，“也”要放在后面那句里：后面的情况和前面一样。' };
    return { msg: '再看看动词在哪儿，“也”放在动词前面。', fix };
  }

  // ---- 并联接头面板 ----
  function showBoard(it, i, n) {
    const el = $('board'); el.classList.remove('hidden');
    let k = -1;
    const parts = it.parts.map((p) => p === null ? `<button type="button" class="slot" data-slot="${++k}">⌁</button>` : `<span class="seg">${ruby(p)}</span>`).join('');
    el.innerHTML = `<h4><span>⚡ 并联接头 · 课本 p35 练习1 · 把“也”放在合适的位置</span><span class="prog">${i + 1} / ${n}</span></h4><div class="sent">${parts}</div><div class="en">${esc(it.en)}</div>`;
    el.querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => submit('#slot' + b.dataset.slot, true)));
  }
  function markBoard(it, r) {
    const el = $('board'); const slots = el.querySelectorAll('.slot');
    slots.forEach((s, k) => { s.classList.remove('ok', 'bad'); s.textContent = '⌁'; const h = s.querySelector('.heat'); if (h) h.remove(); });
    if (r.slot >= 0 && slots[r.slot]) { const s = slots[r.slot]; s.textContent = '也'; s.classList.add(r.ok ? 'ok' : 'bad'); }
    if (ST.plugged && !r.ok) {
      it.cats.forEach((c, k) => {
        const s = slots[k]; if (!s) return; let h = null;
        if (c === 'A') h = ['h3', '最常见错法 · 15/20'];
        if (c === 'END') h = ['h1', '句尾 · 397 处偏误中 0 处'];
        if (c === 'B') h = ['h2', '状语前 · 5/20'];
        if (h) s.insertAdjacentHTML('beforeend', `<span class="heat ${h[0]}" data-ev="${c === 'A' ? 'ln-ye-stat' : c === 'END' ? 'ln-ye-end' : 'ln-ye-3'}">${h[1]}</span>`);
      });
    }
  }
  function hideBoard() { $('board').classList.add('hidden'); }

  // =========================================================== 各站
  const optEn = (o) => { const m = {}; for (const w of o) { const d = D.DICT[w]; if (d) m[w] = d[1]; } return m; };
  function cmpWord(w) {
    const c = D.CARD[w]; const g = c && c.graph;
    const on = g ? { zh: [g.collocations && g.collocations.length ? '搭配：' + g.collocations.map((x) => x.w + (x.n ? ` ${x.n}` : '')).join('、') : '', g.corpus && g.corpus[0] ? '例句：' + g.corpus[0].zh : ''].filter(Boolean).join('；'), src: '点词卡里的“语”字印章看出处', ev: (g.collocations && g.collocations[0] && g.collocations[0].ev) || (g.corpus && g.corpus[0] && g.corpus[0].ev) } : { zh: '（这个词暂未打包语料）', src: '' };
    return { title: `词卡：${w}`, off: { zh: `拼音、英文、课本例句：${(c && c.tb && c.tb.ex) || ''}`, src: '课本' }, on };
  }
  // Curriculum content lives in content/lessons/*.json. This adapter only operates the scene.
  const STATIONS = (LESSON?.stations || []).map(s => ({ key: s.id, name: s.name }));
  const effectTimers = new Set();
  async function lessonAction(id, name, args) {
    chk(id);
    const car = args.car && args.car !== 'main' ? W.show[args.car] : W.car;
    if (name === 'scene') {
      if ('xray' in args) { setXray(args.xray); for (const c of Object.values(W.show)) WD.setXray(c, args.xray); }
      if ('labels' in args) ST.showLbl = args.labels;
      if ('stamp' in args) ST.stamp = args.stamp;
      if (args.wang) placeWang(args.wang);
      if (args.dragon === false) W.dragon.root.visible = false;
      if (args.dragon === 'enter') {
        const dr = W.dragon.root; dr.visible = true; dr.pos = [-5.5, 0, 3.2];
        await walk(dr, [1.2, 0, 2.9], 2.2); chk(id); WD.face(dr, [5, 0, 7]); WD.face(W.wang.root, dr.pos);
      }
      if (args.dragon === 'show') { const dr = W.dragon.root; dr.visible = true; dr.pos = [...LAY.dragonShow]; WD.face(dr, [11 + LAY.showDx, 0, 0]); }
    } else if (name === 'camera') {
      const view = args.view === 'part' ? partView(args.part, car) : args.view === 'end' ? LAY.endCam[0] : VIEWS[args.view];
      if (!view) throw new Error('Unknown lesson camera');
      await camTo(view, args.seconds ?? 1);
    } else if (name === 'focus') { focusPart(args.part || null, car); ST.focus = ['phev','bev','ice'].includes(args.car) ? args.car : 'phev'; }
    else if (name === 'compare') setCompare(args.word ? cmpWord(args.word) : args.value);
    else if (name === 'point') point(args.value);
    else if (name === 'pulse') { if (anim.pulse) setEmis(anim.pulse, null); anim.pulse = args.car ? W.show[args.car].root : null; ST.partLbl = null; }
    else if (name === 'flow') {
      flows(car, { fuel: !!args.fuel, elec: !!args.elec });
      if (args.wheels) anim.wheels = args.wheels;
      if (args.duration) { const timer = setTimeout(() => { effectTimers.delete(timer); if (id === FLOW) flows(car, { fuel: false, elec: false }); }, args.duration); effectTimers.add(timer); }
    } else if (name === 'board') {
      if (args.mode === 'show') showBoard(args.item, args.index, args.total);
      else if (args.mode === 'mark') markBoard(args.item, args.result);
      else hideBoard();
    } else if (name === 'plug') await setPlugged(args.value);
    else if (name === 'animate') act(args.part);
    else if (name === 'sparks') { sparksAtCar(); if (args.dragon) E.tween(0.6, k => { if (id === FLOW) W.dragon.head.rot[0] = Math.sin(k * Math.PI * 4) * 0.25; }); }
    else if (name === 'toast') toast(esc(args.text));
    else if (name === 'teacher') setTeacher(args.text);
    else if (name === 'wait') await sleep(args.ms);
    else if (name === 'departure') {
      const target = W.show[args.car], p0 = [...target.root.pos]; anim.showWheels = 9; flows(target, { fuel: true, elec: true });
      try {
        const follow = camTo(LAY.endCam[1], 3.2);
        await E.tween(3.4, k => { if (id === FLOW) target.root.pos = [p0[0] + 17 * k * k, p0[1], p0[2]]; }, E.ease.lin);
        await follow;
      } finally { anim.showWheels = 0; flows(target, { fuel: false, elec: false }); target.root.pos = p0; }
      chk(id); await camTo(VIEWS.show, 0.6);
    } else throw new Error('Unknown lesson action');
    chk(id);
  }
  function renderSteps() {
    const box = $('steps');
    box.innerHTML = STATIONS.map((s, i) => `<button type="button" data-i="${i}" class="${ST.station === s.key ? 'on' : ST.done.has(s.key) ? 'done' : ''}">${s.name}</button>`).join('');
    // 窄屏时站名一行放不下：把当前这一站滚到中间
    const on = box.querySelector('button.on');
    if (on && box.scrollWidth > box.clientWidth) box.scrollLeft = Math.max(0, on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2);
  }
  $('steps').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) runFrom(Number(b.dataset.i)); });
  async function runFrom(i) {
    const id = ++FLOW;
    cancelCloudRecording(); if (rec) { try { rec.abort(); } catch (_) {} }
    if (askState) { const previous = askState; askState = null; previous.resolve({ cancelled: true }); }
    if (sayResolve) sayResolve();
    effectTimers.forEach(clearTimeout); effectTimers.clear();
    for (const car of [W.car, ...Object.values(W.show)]) flows(car, { fuel: false, elec: false });
    hideInbar(); hideBoard(); closeFix(); closeModal(); closeCard();
    voiceOutput.stop();
    let previousStation = null;
    try {
      if (!LESSON || !window.CDG_LESSON) throw new Error('Missing validated lesson package');
      await window.CDG_LESSON.run(LESSON, {
        say: (who, line, options) => say(id, who, line, options),
        ask: cfg => ask(id, cfg),
        action: (name, args) => lessonAction(id, name, args),
        station(key) { chk(id); if (previousStation) ST.done.add(previousStation); previousStation = key; ST.station = key; currentStep = key + '-intro'; renderSteps(); track('station_enter'); },
        finish() { chk(id); ST.done.add(ST.station); summary(); },
      }, { get plugged() { return ST.plugged; }, level: ST.level, startStation: i });
      chk(id); renderSteps();
    } catch (e) { if (e === CANCEL) return; console.error(e); toast('课堂步骤未能载入。请回到入口或重新选择这一站。'); }
  }

  // =========================================================== 结算 / 关于
  function summary() {
    const evs = [...ST.ev].filter((e) => D.EV[e]);
    track('session_finish', { spoken: ST.spoken, hints: ST.hints, evidenceCount: evs.length });
    const html = `<button class="close" data-x="1">×</button><h2><span class="seal">语</span>出厂检验 · 合格</h2><div class="sub">这辆插电式混合动力汽车可以走了。</div>
      <div class="stats"><div><b>${ST.spoken}</b><small>🔋 语音作答</small></div><div><b>${ST.hints}</b><small>⛽ 用了提示</small></div><div><b>${ST.responses}</b><small>完成的表达尝试</small></div></div><p class="pending">另有 ${ST.selfReported} 次自报跟读。打字、点选和自报跟读不计为检测到的开口；文字识别通过也不代表发音通过。</p>
      ${evs.length ? `<p style="font:15px/1.6 var(--ll-font)">这一遍显示了 <b style="color:var(--zhu)">${evs.length}</b> 条可追溯的语料快照：</p><div style="display:flex;flex-wrap:wrap;gap:6px">${evs.map((e) => `<span class="ll-chip" style="cursor:pointer" data-ev="${e}"><span class="seal sm">语</span> ${esc(D.EV[e].q)}<small>${esc(D.CH[D.EV[e].ch])}</small></span>`).join('')}</div>` : `<p style="font:15px/1.6 var(--ll-font)">${LESSON?.provenance.kind === 'authored-pending-review' ? '本课为自编试课样例，尚未附真实语料。课堂内容仍需教师审阅。' : '本轮使用固定课堂内容，未显示扩展语料；教学正确性要求相同。'}</p>`}
      <div class="btns"><button type="button" data-again="on" class="alt">再练一遍（含语料拓展）</button><button type="button" data-again="off">只练教材内容</button><button type="button" class="ghost" data-x="1">留在车间</button></div>`;
    const m = modal(html);
    m.addEventListener('click', async (e) => { const b = e.target.closest('[data-again]'); if (!b) return; closeModal(); await setPlugged(b.dataset.again === 'on', false); ST.spoken = 0; ST.responses = 0; ST.selfReported = 0; ST.hints = 0; ST.everPlugged = ST.plugged; ST.ev.clear(); ST.done.clear(); gauges(); runFrom(1); });
  }
  function about() {
    const ids = Object.keys(D.EV);
    modal(`<button class="close" data-x="1">×</button><h2><span class="seal">语</span>数据从哪里来</h2><div class="sub">${esc(LESSON?.title || '课堂')} · 离线可用</div>
      <table>
        <tr><th>课文</th><td>${esc(LESSON?.textbook ? `《${LESSON.textbook.name}》第 ${LESSON.textbook.lesson} 课，按提供包作教学改编。` : LESSON?.provenance.note || '课堂自编内容。')}</td></tr>
        <tr><th>词语等级</th><td>《HSK考试大纲》2025-11版：11,000条词汇记录、10,896个词形。7–9级合并；多义词与括号补充等级保留，未做语境判级时按最高可能等级提示。专业词单独标记，不使用识字等级代替词汇等级。</td></tr>
        <tr><th>拼音 / 英文</th><td>课内词使用教学词典；其他词参考 <a href="https://gushichinese.com/hsk-3.0/downloads" target="_blank" rel="noopener noreferrer">Gushi</a> 整理的辅助拼音与英文（<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>），不代表官方词义消歧。本项目依据官方大纲补充等级与序号，保留同形词多记录。词卡第三方例句与共字拓展沿用交付包，不是本次语料检索结果。</td></tr>
        <tr><th>语料</th><td>交付包提供了 ${ids.length} 条带检索记录的语料快照，记录称于 2026-11-07/08 从国际中文教育语料库获取。本次沿用快照，没有重新请求平台核验。点“语”查看原句、来源和样本范围；改写另行标注。</td></tr>
        <tr><th>脚本 / 规则</th><td>课堂推进和判题由本地规则控制。“问师傅”可使用服务端配置的模型，未经配置或校验未通过时返回课堂参考回答。模型回答不会获得“语”印章，也不会替你通过关卡。</td></tr>
        <tr><th>未插电</th><td>使用固定课堂内容，关闭扩展语料显示。两种模式都遵守相同的教学正确性要求，不故意加入没有依据的错误。</td></tr>
        <tr><th>待接入</th><td>HSK 考题库（权限开通后接到词卡）；知识图谱易混词；发音评测（“丝 / 师”这类问题书面语料证明不了，评测结果不盖“语”字印章）。</td></tr>
        <tr><th>语音</th><td>默认离线，可打字、输入拼音或点选。启用联机后，首次录音会说明音频去向。云端识别不可用时降级为浏览器识别；没有实测发音结果时不显示分数。应用不保存录音。</td></tr>
      </table>
      <h3 style="font:600 14px var(--ll-font);margin:14px 0 6px">全部证据</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${ids.map((e) => `<span class="ll-chip" style="cursor:pointer" data-ev="${e}"><span class="seal sm">语</span> ${esc(D.EV[e].q)}<small>${esc(D.CH[D.EV[e].ch])}${D.EV[e].hits != null ? ' · ' + D.EV[e].hits + ' 条' : ''}</small></span>`).join('')}</div>
      <div class="note">学习者语料（中介语库）是 HSK 动态作文，考生以日韩和东南亚为主：对“写”的诊断强，对“说”要打折；国籍比例不代表总体。</div>`);
  }

  // =========================================================== 启动
  if (LESSON && $('lessonSelect')) {
    const select = $('lessonSelect');
    select.innerHTML = Object.values(window.CDG_LESSONS || {}).map(l => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
    select.value = LESSON.id;
    select.onchange = () => { const url = new URL(location.href); url.searchParams.set('lesson', select.value); location.href = url.href; };
    if ($('lessonBadge')) $('lessonBadge').textContent = LESSON.id === 'nev-l4' ? '第4课' : LESSON.title;
    document.title = '插电工坊 · ' + LESSON.title;
    const lead = document.querySelector('.ll-lead');
    if (lead) lead.innerHTML = `${esc(LESSON.title)}<br>先看示范，再练习表达，最后教会小龙。<br><small>${esc(LESSON.provenance.note)}</small>`;
  }
  function start(lv) {
    if (lv === 't') { ST.level = 2; ST.teacher = true; ST.compare = false; if (!AUTO) void setPlugged(true, false); } else ST.level = Number(lv) || 2;
    $('gate').classList.add('hidden');
    track('session_start', { level: ST.level, plugged: ST.plugged });
    for (const id of ['topbar', 'hud']) $(id).classList.remove('hidden');
    syncTools(); gauges(); renderCompare(); renderSteps();
    voiceOutput.stop();
    runFrom(AUTO && AUTO.station != null ? AUTO.station : 0);
  }
  $('gate').addEventListener('click', (e) => { const b = e.target.closest('[data-lv]'); if (b) start(b.dataset.lv); });
  const q = new URLSearchParams(location.search);
  if (characters?.options.length) {
    $('characterPicker').classList.remove('hidden');
    const select = $('characterSelect');
    select.innerHTML = characters.options.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    const requested = q.get('character') || characters.defaultId;
    const initial = characters.options.some(o=>o.id===requested) ? requested : characters.options[0].id;
    select.value = initial; select.onchange = () => void selectCharacter(select.value);
    $('tools').querySelector('[data-t="character"]').classList.remove('hidden');
    void selectCharacter(initial);
  }
  requestAnimationFrame(frame);
  if (window.CDG_MARBLE && SW) { const m = window.CDG_MARBLE; loadMarble(b64ToBuf(m.b64), m.name, m.meta, m.place); }
  if (AUTO && AUTO.camera) setTimeout(() => { const c = AUTO.camera; cam.target = c.target; cam.yaw = c.yaw; cam.pitch = c.pitch; cam.dist = c.dist; window.__lockCam = true; }, AUTO.cameraDelay || 2500);
  if (AUTO) {
    (async () => {
      if (AUTO.plug) await setPlugged(true, false);
      if (AUTO.compare) ST.compare = true; if (AUTO.teacher) ST.teacher = true;
      start(AUTO.level || 2);
      if (AUTO.card) setTimeout(() => openWord(AUTO.card), AUTO.cardDelay || 300);
      if (AUTO.ev) setTimeout(() => openEv(AUTO.ev), 600);
      if (AUTO.view) setTimeout(() => { const v = VIEWS[AUTO.view]; cam.target = [...v.target]; cam.yaw = v.yaw; cam.pitch = v.pitch; cam.dist = v.dist; }, AUTO.viewDelay || 1600);
      if (AUTO.xray) setTimeout(() => setXray(true), 100);
      if (AUTO.onlySplat) setTimeout(() => { for (const c of W.root.children) c.visible = false; for (const o of LBL) o.show = () => false; }, 200);
    })();
  } else if (q.get('level')) start(q.get('level'));
  if (AUTO || q.get('debug') === '1') window.__cdg = { ST, W, cam, submit, openWord, setPlugged, VIEWS, characters, npcTiming: { snapshot: npcTiming.snapshot, clear: npcTiming.clear }, get currentPrompt() { if (!askState) return null; const { check, ...cfg } = askState.cfg; return cfg; }, dbg: { fitLayout, clampCam, applyLayout, MAR, R, get LAY() { return LAY; }, get FIT() { return FIT; } } };
})();
