/* Declarative lesson runner. JSON contains data, never executable expressions. */
(function (G) {
  'use strict';
  const L = G.CDG_LOGIC || (typeof require !== 'undefined' ? require('./logic.js') : null);
  const ACTIONS = Object.freeze(['scene', 'camera', 'focus', 'compare', 'point', 'pulse', 'flow', 'board', 'plug', 'animate', 'sparks', 'toast', 'teacher', 'wait', 'departure']);
  const CHECKS = Object.freeze(['word', 'confirm', 'yeItem', 'dragonFix', 'whyHybrid', 'dianWord', 'question', 'choice']);
  const PATH = /^(state\.(plugged|level|focus)|input|normalized|chip|answer|result(?:\.[A-Za-z][A-Za-z0-9_]*)*)$/;
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fail = (p, s) => { throw new Error(`Lesson ${p}: ${s}`); };
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, p) => { if (typeof v !== 'string' || !v.trim()) fail(p, 'expected nonempty string'); };
  const identifier = (v, p) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(v)) fail(p, 'expected ASCII identifier (1..80 characters)'); };
  const keys = (v, allowed, p) => { if (!obj(v)) fail(p, 'expected object'); for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${p}.${k}`, 'unknown field'); };
  function path(p) { if (typeof p !== 'string' || !PATH.test(p) || p.split('.').some(k => forbidden.has(k))) fail('reference', `invalid path ${p}`); }
  function read(p, ctx) { path(p); return p.split('.').reduce((v, k) => v != null && own(Object(v), k) ? v[k] : undefined, ctx); }
  function resolve(v, ctx) {
    if (Array.isArray(v)) return v.map(x => resolve(x, ctx));
    if (obj(v)) {
      if (own(v, '$ref')) return read(v.$ref, ctx);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
    }
    if (typeof v === 'string') return v.replace(/\{\{([^{}]+)\}\}/g, (_, p) => String(read(p, ctx) ?? ''));
    return v;
  }
  function condition(c, ctx) {
    if (own(c, 'all')) return c.all.every(x => condition(x, ctx));
    if (own(c, 'any')) return c.any.some(x => condition(x, ctx));
    if (own(c, 'not')) return !condition(c.not, ctx);
    const v = read(c.path, ctx);
    if (own(c, 'is')) return v === c.is;
    if (own(c, 'in')) return c.in.includes(v);
    if (own(c, 'contains')) return typeof v === 'string' && v.includes(c.contains);
    if (own(c, 'startsWith')) return typeof v === 'string' && v.startsWith(c.startsWith);
    return !!v === c.truthy;
  }
  function validateCondition(c, p) {
    if (!obj(c)) fail(p, 'expected condition');
    for (const mode of ['all', 'any']) if (own(c, mode)) {
      keys(c, [mode], p); if (!Array.isArray(c[mode]) || !c[mode].length) fail(p, 'empty condition');
      c[mode].forEach((x, i) => validateCondition(x, `${p}.${mode}[${i}]`)); return;
    }
    if (own(c, 'not')) { keys(c, ['not'], p); validateCondition(c.not, p + '.not'); return; }
    keys(c, ['path', 'is', 'in', 'contains', 'startsWith', 'truthy'], p); path(c.path);
    if (Object.keys(c).length !== 2) fail(p, 'one condition operator required');
    if (own(c, 'in') && (!Array.isArray(c.in) || !c.in.length)) fail(p, 'in requires values');
    if (own(c, 'truthy') && typeof c.truthy !== 'boolean') fail(p, 'truthy requires boolean');
    for (const k of ['contains', 'startsWith']) if (own(c, k)) str(c[k], `${p}.${k}`);
  }
  function validate(lesson) {
    let nodes = 0;
    function data(v, p, depth = 0) {
      if (++nodes > 150000 || depth > 60) fail(p, 'document too large/deep');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'number') { if (!Number.isFinite(v)) fail(p, 'non-finite number'); return; }
      if (typeof v === 'string') { for (const m of v.matchAll(/\{\{([^{}]+)\}\}/g)) path(m[1]); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => data(x, `${p}[${i}]`, depth + 1)); return; }
      if (!obj(v) || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) fail(p, 'only plain JSON data allowed');
      if (own(v, '$ref')) { keys(v, ['$ref'], p); path(v.$ref); }
      for (const [k, x] of Object.entries(v)) { if (forbidden.has(k)) fail(p, 'unsafe key'); data(x, `${p}.${k}`, depth + 1); }
    }
    data(lesson, 'root');
    keys(lesson, ['schemaVersion', 'id', 'title', 'provenance', 'textbook', 'level', 'roles', 'facts', 'vocabulary', 'grammar', 'dict', 'evidence', 'channels', 'cards', 'wordChains', 'hsk', 'assets', 'pools', 'stations'], 'root');
    if (lesson.schemaVersion !== 1) fail('schemaVersion', 'expected 1');
    identifier(lesson.id, 'id'); str(lesson.title, 'title');
    if (!obj(lesson.provenance) || !['textbook-adaptation', 'authored-pending-review'].includes(lesson.provenance.kind)) fail('provenance', 'explicit source kind required');
    str(lesson.provenance.note, 'provenance.note');
    if (!obj(lesson.level) || !Array.isArray(lesson.level.range) || lesson.level.range.length !== 2 || !lesson.level.range.every(Number.isInteger) || lesson.level.range[0] < 1 || lesson.level.range[1] > 9 || lesson.level.range[0] > lesson.level.range[1] || !Number.isInteger(lesson.level.default) || lesson.level.default < lesson.level.range[0] || lesson.level.default > lesson.level.range[1]) fail('level', 'invalid level range/default');
    for (const k of ['dict', 'evidence', 'cards', 'pools']) if (!obj(lesson[k])) fail(k, 'object required');
    for (const [id, e] of Object.entries(lesson.evidence)) {
      if (!obj(e) || !Number.isInteger(e.ch) || e.ch < 0 || e.ch > 4 || !(e.hits === null || Number.isInteger(e.hits) && e.hits >= 0)) fail(`evidence.${id}`, 'channel/hits required (null for grouped counts)');
      for (const k of ['q', 'at', 'src']) str(e[k], `evidence.${id}.${k}`);
    }
    function evidence(id, p) { if (id != null && (typeof id !== 'string' || !own(lesson.evidence, id))) fail(p, `missing evidence ${String(id)}`); }
    function evidenceTree(v, p) {
      if (Array.isArray(v)) return v.forEach((x, i) => evidenceTree(x, `${p}[${i}]`));
      if (!obj(v)) return;
      for (const [k, x] of Object.entries(v)) { if (['ev', 'seal'].includes(k)) evidence(x, p + '.' + k); evidenceTree(x, p + '.' + k); }
    }
    evidenceTree(lesson.cards, 'cards');
    if (lesson.assets) {
      evidenceTree(lesson.assets, 'assets');
      if (lesson.assets.shelf) {
        if (!Array.isArray(lesson.assets.shelf) || lesson.assets.shelf.length > 15) fail('assets.shelf', 'at most 15 shelf entries');
        const perBay = [0, 0, 0];
        for (const t of lesson.assets.shelf) {
          keys(t, ['bay', 'w', 'note', 'ev', 'on', 'grey'], 'shelf entry');
          if (!Number.isInteger(t.bay) || t.bay < 0 || t.bay > 2 || ++perBay[t.bay] > 5) fail('assets.shelf', '3 bays, at most 5 entries per bay');
          str(t.w, 'assets.shelf.w'); str(t.note, 'assets.shelf.note');
        }
      }
      if (lesson.assets.shelfBayNames && (!Array.isArray(lesson.assets.shelfBayNames) || lesson.assets.shelfBayNames.length !== 3 || !lesson.assets.shelfBayNames.every(x => typeof x === 'string' && x.trim()))) fail('assets.shelfBayNames', '3 nonempty bay names required');
    }
    const suggestEvidence = { A: 'ln-ye-stat', yeA: 'ln-ye-stat', END: 'ln-ye-end', yeEnd: 'ln-ye-end', B: 'ln-ye-3', shiduima: 'ln-dm-1', maduima: 'ln-dm-0', xhdc: 'ct-xh' };
    const seenSteps = new Set(); let commandCount = 0;
    function commands(xs, p, attempt = false) {
      if (!Array.isArray(xs) || xs.length > 500) fail(p, 'command array required (max 500)');
      xs.forEach((c, i) => {
        const at = `${p}[${i}]`; if (++commandCount > 5000) fail(at, 'too many commands');
        if (!obj(c)) fail(at, 'command required');
        if (attempt && !['action', 'if'].includes(c.op)) fail(at, 'attempt effects only allow action/if');
        if (c.op === 'say') {
          keys(c, ['op', 'who', 'line', 'options'], at); str(c.who, at + '.who');
          if (!obj(c.line) || !(typeof c.line.zh === 'string' || obj(c.line.zh) && own(c.line.zh, '$ref'))) fail(at, 'line.zh required');
          evidenceTree(c.options, at + '.options');
        } else if (c.op === 'action') {
          keys(c, ['op', 'name', 'args'], at); if (!ACTIONS.includes(c.name)) fail(at, `unknown action ${c.name}`);
          if (!obj(c.args)) fail(at, 'action args required'); evidenceTree(c.args, at + '.args');
          if (c.name === 'wait' && (!Number.isFinite(c.args.ms) || c.args.ms < 0 || c.args.ms > 30000)) fail(at, 'wait outside 0..30000ms');
        } else if (c.op === 'if') {
          keys(c, ['op', 'when', 'then', 'else'], at); validateCondition(c.when, at + '.when'); commands(c.then, at + '.then', attempt); if (c.else) commands(c.else, at + '.else', attempt);
        } else if (c.op === 'pool') {
          keys(c, ['op', 'id', 'count'], at); if (!own(lesson.pools, c.id)) fail(at, `unknown pool ${c.id}`);
          if (c.count != null && (!Number.isInteger(c.count) || c.count < 1 || c.count > lesson.pools[c.id].length)) fail(at, 'invalid pool count');
        } else if (c.op === 'ask') {
          keys(c, ['op', 'id', 'cfg', 'check', 'feedback', 'attempt', 'after'], at); identifier(c.id, at + '.id');
          if (seenSteps.has(c.id)) fail(at, `duplicate step ${c.id}`); seenSteps.add(c.id);
          keys(c.cfg, ['stage', 'task', 'options', 'optEn', 'examples', 'answer', 'hints', 'noInput', 'noAnswerChip', 'plugAction', 'speechTarget'], at + '.cfg'); str(c.cfg.task, at + '.cfg.task');
          const ch = c.check; if (!obj(ch) || !CHECKS.includes(ch.type)) fail(at, 'unsupported check');
          const fields = { word: ['target', 'others', 'alts', 'selfReport'], confirm: ['truth', 'fixes'], yeItem: ['item'], dragonFix: [], whyHybrid: [], dianWord: [], question: [], choice: ['answers', 'mode'] };
          keys(ch, ['type', ...fields[ch.type]], at + '.check');
          if (ch.type === 'word') { str(ch.target, at + '.target'); for (const alt of ch.alts || []) { if (typeof alt !== 'string') { keys(alt, ['value', 'when'], at + '.alt'); str(alt.value, at + '.alt.value'); validateCondition(alt.when, at + '.alt.when'); } } }
          if (ch.type === 'confirm' && typeof ch.truth !== 'boolean') fail(at, 'confirm.truth boolean required');
          if (ch.type === 'choice' && (!Array.isArray(ch.answers) || !ch.answers.length || !ch.answers.every(x => typeof x === 'string' && x.length) || ch.mode && !['exact', 'contains', 'prefix'].includes(ch.mode))) fail(at, 'invalid choice answers/mode');
          if (ch.type === 'yeItem') {
            const it = ch.item; if (!obj(it) || !Array.isArray(it.parts) || !it.parts.every(x => x === null || typeof x === 'string') || !Array.isArray(it.cats) || it.cats.length !== it.parts.filter(x => x === null).length || !Number.isInteger(it.ok) || it.ok < 0 || it.ok >= it.cats.length) fail(at, 'invalid ye item');
          }
          if (!Array.isArray(c.feedback) || !c.feedback.length) fail(at, 'feedback required');
          for (const [j, f] of c.feedback.entries()) {
            keys(f, ['when', 'msg', 'seal', 'suggest'], `${at}.feedback[${j}]`); if (f.when) validateCondition(f.when, at + '.feedback.when');
            str(f.msg, at + '.feedback.msg'); evidence(f.seal, at + '.feedback.seal');
            if (f.suggest) {
              keys(f.suggest, ['kind', 'kinds', 'wrong', 'right', 'sentence'], at + '.suggest');
              const kinds = typeof f.suggest.kind === 'string' ? [f.suggest.kind] : f.suggest.kinds;
              if (!Array.isArray(kinds) || !kinds.length) fail(at, 'dynamic suggestion must enumerate kinds');
              for (const kind of kinds) { if (!['A', 'B', 'END', 'yeA', 'yeEnd', 'shiduima', 'maduima', 'xhdc', 'ne', 'noTag', 'noSubj', 'noPred'].includes(kind)) fail(at, 'unknown suggestion kind'); if (suggestEvidence[kind]) evidence(suggestEvidence[kind], at + '.suggest'); }
            }
          }
          if (c.attempt) commands(c.attempt, at + '.attempt', true); if (c.after) commands(c.after, at + '.after');
        } else if (c.op === 'finish') { keys(c, ['op'], at); }
        else fail(at, `unknown command ${String(c.op)}`);
      });
    }
    for (const [id, pool] of Object.entries(lesson.pools)) {
      identifier(id, 'pool id'); if (!Array.isArray(pool) || !pool.length || pool.length > 100) fail(`pools.${id}`, 'nonempty fixed pool required');
      pool.forEach((item, i) => { keys(item, ['id', 'commands'], `pools.${id}[${i}]`); identifier(item.id, 'pool item id'); commands(item.commands, `pools.${id}[${i}].commands`); });
    }
    if (!Array.isArray(lesson.stations) || !lesson.stations.length || lesson.stations.length > 30) fail('stations', '1..30 stations required');
    const ids = new Set();
    for (const s of lesson.stations) { keys(s, ['id', 'name', 'commands'], 'station'); identifier(s.id, 'station.id'); str(s.name, 'station.name'); if (ids.has(s.id)) fail('stations', 'duplicate station'); ids.add(s.id); commands(s.commands, `stations.${s.id}`); }
    const last = lesson.stations.at(-1).commands.at(-1); if (!last || last.op !== 'finish') fail('stations', 'last station must end in finish');
    function checkFinish(xs) { for (const c of xs) { if (c.op === 'finish' && c !== last) fail('finish', 'only allowed at the end of the final station'); for (const k of ['then', 'else', 'after', 'attempt']) checkFinish(c[k] || []); } }
    lesson.stations.forEach(s => checkFinish(s.commands)); Object.values(lesson.pools).flat().forEach(p => checkFinish(p.commands));
    // Prevent recursive pool expansion before any adapter side effects.
    const visiting = new Set(), visited = new Set();
    function findPools(xs) { return xs.flatMap(c => c.op === 'pool' ? [c.id] : [...findPools(c.then || []), ...findPools(c.else || []), ...findPools(c.after || []), ...findPools(c.attempt || [])]); }
    function visit(id) { if (visiting.has(id)) fail('pools', 'recursive pool'); if (visited.has(id)) return; visiting.add(id); for (const entry of lesson.pools[id]) for (const child of findPools(entry.commands)) visit(child); visiting.delete(id); visited.add(id); }
    Object.keys(lesson.pools).forEach(visit);
    return { ok: true, steps: seenSteps.size, stations: ids.size };
  }
  function diagnose(ch, t, chip, ctx, lesson) {
    const n = L.norm(t);
    if (ch.type === 'word') {
      if (ch.selfReport && chip && t === ch.selfReport) return { ok: true, selfReported: true };
      const alts = (ch.alts || []).filter(a => typeof a === 'string' || condition(a.when, ctx)).map(a => typeof a === 'string' ? a : a.value);
      let input = t;
      // Let the existing word checker handle new lesson vocabulary, including its pinyin.
      if (!/[㐀-鿿]/.test(t)) for (const w of [ch.target, ...alts, ...(ch.others || [])]) if (lesson.dict[w] && L.plainPy(t) === L.plainPy(lesson.dict[w][0])) { input = w; break; }
      return L.heardWord(input, ch.target, ch.others || [], alts);
    }
    if (ch.type === 'confirm') return L.judgeConfirm(t, ch.truth, ch.fixes || []);
    if (ch.type === 'yeItem') { const slot = /^#slot(\d+)$/.exec(t); if (slot && Number(slot[1]) >= ch.item.cats.length) return { ok: false, mismatch: true, cat: 'none', slot: -1 }; return L.judgeYeItem(ch.item, slot ? Number(slot[1]) : t); }
    if (ch.type === 'dragonFix') return L.judgeDragonFix(t);
    if (ch.type === 'whyHybrid') return L.judgeWhyHybrid(t);
    if (ch.type === 'dianWord') return L.judgeDianWord(t);
    if (ch.type === 'choice') return { ok: ch.answers.some(a => ch.mode === 'contains' ? n.includes(L.norm(a)) : ch.mode === 'prefix' ? n.startsWith(L.norm(a)) : n === L.norm(a)) };
    const q = L.parseQuestion(t, ctx.state.focus);
    if (q.ok) return { ok: true, q, answer: L.answerQuestion(q), answerEn: q.truth ? 'Yes.' : 'No — that is not right.', part: ['engine', 'motor', 'battery'].includes(q.key) ? q.key : null };
    const body = (q.body || '').replace(/(是对吗|吗对吗|呢)$/, '');
    const subjOnly = /^(插电式混合动力汽车|纯电动汽车|纯电动车|燃油车|它|这辆车)$/.test(body.replace(/是$/, ''));
    const sentence = q.err === 'noTag' ? `${q.body}，对吗？` : ['shiduima', 'maduima'].includes(q.err) ? (subjOnly ? `${body.replace(/是$/, '')}是新能源汽车，对吗？` : `${body.replace(/是$/, '')}，对吗？`) : q.err === 'xhdc' ? `${q.body.replace('消耗电池', '消耗电能')}，对吗？`.replace(/(对吗|对吧)，对吗？$/, '$1？') : q.err === 'yeA' ? L.fixYeSentence(q.body).replace(/。$/, '，对吗？') : '';
    return { ok: false, ...q, sentence, kind: ({ yeA: 'A', yeEnd: 'END' })[q.err] || q.err };
  }
  async function run(lesson, adapter, options = {}) {
    validate(lesson);
    for (const k of ['say', 'ask', 'action', 'station', 'finish']) if (typeof adapter[k] !== 'function') fail('adapter', `${k} function required`);
    if (!L) fail('runtime', 'CDG_LOGIC required');
    const level = options.level == null ? lesson.level.default : options.level;
    if (!Number.isInteger(level) || level < lesson.level.range[0] || level > lesson.level.range[1]) fail('options.level', 'outside lesson range');
    const start = options.startStation == null ? 0 : typeof options.startStation === 'number' ? options.startStation : lesson.stations.findIndex(s => s.id === options.startStation);
    if (!Number.isInteger(start) || start < 0 || start >= lesson.stations.length) fail('options.startStation', 'unknown station');
    const pluggedGetter = Object.getOwnPropertyDescriptor(options, 'plugged')?.get;
    const state = { plugged: !!options.plugged, level, focus: 'phev' };
    let ctx = { state, result: {}, input: '', normalized: '', chip: false, answer: '' }, finished = false, budget = 20000;
    const refresh = () => { if (pluggedGetter) state.plugged = !!options.plugged; };
    async function action(c, context) { const args = resolve(c.args, context); await adapter.action(c.name, args); if (c.name === 'plug') { state.plugged = !!args.value; refresh(); } }
    async function execute(xs, context = ctx) {
      for (const c of xs) {
        if (--budget < 0) fail('runtime', 'command budget exceeded'); if (finished) fail('runtime', 'command after finish'); refresh();
        if (c.op === 'action') await action(c, context);
        else if (c.op === 'say') { const opts = resolve(c.options || {}, context); if (!state.plugged) delete opts.seal; await adapter.say(c.who, resolve(c.line, context), opts); }
        else if (c.op === 'if') await execute(condition(c.when, context) ? c.then : c.else || [], context);
        else if (c.op === 'pool') { for (const item of lesson.pools[c.id].slice(0, c.count)) await execute(item.commands, context); }
        else if (c.op === 'ask') {
          const cfg = resolve(c.cfg, context); let attemptQueue = Promise.resolve(), last = null, closed = false, attempts = 0;
          cfg.step = c.id;
          cfg.check = (text, chip = false) => {
            if (closed) throw new Error('Closed lesson prompt'); if (++attempts > 500) fail(c.id, 'attempt budget exceeded'); refresh();
            const input = String(text || '').trim();
            const local = { state: { ...state }, input, normalized: L.norm(input), chip: !!chip, answer: cfg.answer || '', result: {} };
            const r = diagnose(c.check, input, chip, local, lesson); local.result = r;
            const f = c.feedback.find(f => !f.when || condition(f.when, local));
            if (f) {
              r.msg = resolve(f.msg, local); if (f.seal && state.plugged) r.seal = f.seal;
              if (f.suggest) {
                const s = resolve(f.suggest, local);
                if (!s.kinds || s.kinds.includes(s.kind)) {
                  const sugs = L.suggest(s.kind, s, state.plugged);
                  for (const item of sugs) if (item.ev && !own(lesson.evidence, item.ev)) fail('feedback', `missing evidence ${item.ev}`);
                  if (sugs.length && s.sentence) r.fix = { was: input, sugs };
                  if (state.plugged && sugs[0]?.ev) r.seal = sugs[0].ev;
                }
              }
            }
            last = local;
            if (c.attempt) attemptQueue = attemptQueue.then(() => execute(c.attempt, local));
            // Attach a handler immediately; the awaited original promise still propagates failure.
            attemptQueue.catch(() => {});
            return r;
          };
          const answer = await adapter.ask(cfg); closed = true; await attemptQueue;
          if (!last || !last.result.ok || !answer || answer.r !== last.result || answer.text !== last.input) fail(c.id, 'adapter must return the successful checked {text,r}');
          Object.assign(ctx, last, { state }); context = ctx;
          if (last.result.q) state.focus = last.result.q.type;
          if (c.after) await execute(c.after, ctx);
        } else if (c.op === 'finish') { finished = true; await adapter.finish(); }
      }
    }
    for (const station of lesson.stations.slice(start)) { await adapter.station(station.id, station.name); await execute(station.commands, ctx); }
    return { lesson: lesson.id, finished, plugged: state.plugged, level };
  }
  G.CDG_LESSON = { validate, run, ACTIONS, CHECKS };
  if (typeof module !== 'undefined') module.exports = G.CDG_LESSON;
})(typeof window !== 'undefined' ? window : globalThis);
