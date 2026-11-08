import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reuse the exact browser dictionaries, fact table and teaching scripts. No second fact table.
const scope = vm.createContext({});
for (const file of ['data.js', 'hsk.js', 'logic.js', 'script.js', 'lesson.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', file), 'utf8'), scope, { filename: file, timeout: 1000 });
}
export const DATA = scope.CDG_DATA;
export const HSK = scope.CDG_HSK;
export const LOGIC = scope.CDG_LOGIC;
export const SCRIPT = scope.CDG_SCRIPT;
export const SESSION_RE = /^s_[a-zA-Z0-9_-]{12,80}$/;
export const STATIONS = new Set(['intro', 'a', 'b', 'c', 'd', 'end']);
const CONTENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const ERROR_IDS = Object.keys(DATA.EV).filter((id) => /^ln-ye-[1-4]$/.test(id));
export const ERROR_SAMPLES = ERROR_IDS.flatMap((id) => {
  const original = DATA.EV[id].zh;
  const clauses = original.split(/[，。]/).map((s) => s.replace(/^…+/, '')).filter((s) => s.includes('也') && !s.endsWith('也'));
  return [{ id, zh: original, kind: 'original' }, ...clauses.map((zh) => ({ id, zh: zh + '。', kind: 'excerpt' }))];
});
const TEACHING_ANSWERS = new Set(['“也”放在动词前。', '先说主语，再说“也”。', '请用“对吗”来确认。', '“呢”是问另一个。', '先读这个词，再说一句话。', '请点这个词，看拼音。', '请先看零件，再说它的名字。']);

export function validateLesson(lesson, expectedId) {
  if (!lesson || typeof lesson !== 'object' || lesson.id !== expectedId || !CONTENT_ID.test(lesson.id || '')) return false;
  try {
    // Parse within the validator's realm so its plain-JSON prototype guard remains effective.
    scope.__lessonSource = JSON.stringify(lesson);
    vm.runInContext('CDG_LESSON.validate(JSON.parse(__lessonSource))', scope, { timeout: 1000 });
    return lesson.stations.every((station) => CONTENT_ID.test(station.id))
      && [lesson.vocabulary, lesson.grammar].every((items) => Array.isArray(items) && items.every((x) => typeof x === 'string'))
      && Object.values(lesson.dict).every((entry) => Array.isArray(entry) && entry.length >= 2 && entry.slice(0, 2).every((x) => typeof x === 'string'));
  } catch { return false; }
  finally { delete scope.__lessonSource; }
}
export function readLesson(id, lessonDir = path.join(ROOT, 'content', 'lessons')) {
  if (!CONTENT_ID.test(id || '')) return null;
  try {
    const source = fs.readFileSync(path.join(lessonDir, `${id}.json`), 'utf8');
    if (source.length > 1_000_000) return null;
    const lesson = JSON.parse(source);
    return validateLesson(lesson, id) ? lesson : null;
  } catch { return null; }
}
export function lessonExists(id) {
  return Boolean(readLesson(id));
}

export function overLevel(text, level, content) {
  if (level === 0) return [];
  const result = new Map();
  // Preserve lesson-authored professional terms as one token, without assigning them an HSK grade.
  const extra = Object.keys(content?.dict || {}).filter((w) => !Object.hasOwn(DATA.DICT, w)).sort((a, b) => b.length - a.length);
  const tokens = [];
  let rest = String(text || '');
  while (rest) {
    const next = extra.map((word) => ({ word, at: rest.indexOf(word) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at || b.word.length - a.word.length)[0];
    if (!next) { tokens.push(...LOGIC.segment(rest)); break; }
    tokens.push(...LOGIC.segment(rest.slice(0, next.at)));
    const [, en, tag] = content.dict[next.word];
    tokens.push({ t: next.word, zh: true, en, tag });
    rest = rest.slice(next.at + next.word.length);
  }
  for (const token of tokens) {
    if (!token.zh) continue;
    const entry = HSK.w[token.t];
    if (!entry || entry[0] > level) result.set(token.t, {
      w: token.t, hsk: entry?.[0] ?? null,
      en: token.en || entry?.[2] || '', professional: !entry && ['n', 'r', 'x'].includes(token.tag),
    });
  }
  return [...result.values()];
}

export function cleanTurn(body) {
  if (!body || !SESSION_RE.test(body.sessionId || '')) throw new Error('invalid_session');
  const lesson = readLesson(body.lesson || 'nev-l4');
  if (!lesson) throw new Error('unknown_lesson');
  if (!lesson.stations.some((s) => s.id === (body.station || 'intro'))) throw new Error('invalid_station');
  if (!['wang', 'dragon'].includes(body.role || 'wang')) throw new Error('invalid_role');
  if (!Number.isInteger(body.level) || body.level < 0 || body.level > 3) throw new Error('invalid_level');
  const userText = String(body.userText || '').trim();
  if (!userText || userText.length > 500) throw new Error('invalid_text');
  const step = String(body.step || 'free-question');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(step)) throw new Error('invalid_step');
  return {
    sessionId: body.sessionId, lesson: body.lesson || 'nev-l4', station: body.station || 'intro', step,
    role: body.role || 'wang', level: body.level, plugged: body.plugged === true, userText,
    history: Array.isArray(body.history) ? body.history.slice(-6).filter((x) => ['wang', 'dragon', 'you'].includes(x?.who) && typeof x.zh === 'string').map((x) => ({ who: x.who, zh: x.zh.slice(0, 160) })) : [],
    maxChars: [24, 10, 14, 18][body.level],
    timeoutMs: Math.min(2500, Math.max(100, Number(body.budget?.timeoutMs) || 2500)),
    // allowedWords, allowedErrors and facts supplied by a browser cannot authorize facts or evidence.
    allowedWords: Object.keys(lesson.dict), allowedErrors: body.plugged === true ? ERROR_IDS.filter((id) => lesson.evidence[id]) : [], facts: LOGIC.FACT,
    content: lesson,
  };
}

const predicates = { nev: ['不是新能源汽车', '是新能源汽车'], engine: ['没有发动机', '有发动机'], motor: ['没有驱动电机', '有驱动电机'], battery: ['没有动力电池', '有动力电池'], fuel: ['不消耗燃油', '消耗燃油'], elec: ['不消耗电能', '消耗电能'] };
export function factLine(subject, predicate) {
  if (!Object.hasOwn(LOGIC.FACT, subject) || !Object.hasOwn(predicates, predicate)) return null;
  return `它${predicates[predicate][Number(Boolean(LOGIC.FACT[subject][predicate]))]}。`;
}
export function questionFact(text) {
  const named = [/插电|插混|混合动力|混动车/, /纯电动|纯电车/, /燃油车/].filter((pattern) => pattern.test(text));
  if (named.length > 1) return null; // A singular “it” answer cannot safely resolve a multi-vehicle comparison.
  const subject = /纯电动|纯电车/.test(text) ? 'bev' : /燃油车/.test(text) && !/插电|混合/.test(text) ? 'ice' : 'phev';
  for (const [pattern, predicate] of [[/发动机/, 'engine'], [/驱动电机|电机/, 'motor'], [/动力电池|电池/, 'battery'], [/燃油|汽油|用油|烧油/, 'fuel'], [/电能|用电|耗电/, 'elec'], [/新能源/, 'nev']]) {
    if (pattern.test(text) && /有没有|是否|是不是|有.*吗|没有.*吗|对吗|对吧|消耗.*吗|用.*吗|烧.*吗|是.*吗/.test(text)) return { subject, predicate };
  }
  return null;
}

const wordKeys = Object.keys(DATA.DICT).sort((a, b) => b.length - a.length);
const normQuote = (text) => String(text || '').replace(/[“”‘’「」『』"']/g, '');
const GRAMMAR = {
  ye: { variants: ['“也”在动词前。', '先说主语，再说“也”。'], en: '也 goes after the subject, immediately before the verb.', sourceRef: 'script.yeItems; CARD.也.tb' },
  confirm: { variants: ['用“对吗”来确认。', '说完，再问“对吗”。'], en: 'Use 对吗 after a statement when you want someone to confirm it.', sourceRef: 'script.cAsk; CARD.对吗.tb' },
  ne: { variants: ['“呢”是问另一个。', '你呢？是问你。'], en: '呢 can ask “what about …?”; it is different from checking with 对吗.', sourceRef: 'script.neItems' },
  hybrid: { variants: ['它有发动机，也有驱动电机。'], en: 'This lesson’s plug-in hybrid has an engine and a driving motor.', sourceRef: 'script.aHybrid; FACT.phev' },
  plug: { variants: ['这儿可以插电。'], en: 'Plug-in: this vehicle can be connected to an external power supply.', sourceRef: 'script.aPlug' },
};
const SUPPORT = {
  nervous: { variants: ['没关系，我们慢慢说。', '你会的词，也可以教我。'], en: 'Start with what you know. We can take one small step at a time.', sourceRef: 'teaching:learner-agency' },
  repeat: { variants: ['先说一个词。', '我们慢慢说。'], en: 'Try a single word first, then build a sentence with help.', sourceRef: 'teaching:scaffolding' },
  goal: { variants: ['今天学“也”和“对吗”。'], en: 'Name vehicle parts, use 也, and ask for confirmation with 对吗.', sourceRef: 'script.aRecog; script.yeItems; script.cAsk' },
  teach: { variants: ['请师傅教我。', '你先说，我跟你学。'], en: 'You are the teacher now. Help the apprentice explain the idea.', sourceRef: 'script.dIntro; teaching:teachback' },
};
function cardFor(word, turn) {
  const cards = turn.content?.cards || DATA.CARD;
  const card = cards[word];
  return card?.alias ? cards[card.alias] : card;
}
function fits(text, turn) {
  return [...text.replace(/[^\p{Script=Han}]/gu, '')].length <= turn.maxChars && text.length <= 160 && overLevel(text, turn.level, turn.content).length <= 2;
}
function reply(zh, en, grounding, evidence = []) {
  return { intent: 'answer', zh, en, teacher: '', grounding, evidence, seal: false };
}

/** Read-only tool rendering. The model chooses a lookup; its generated factual wording is discarded. */
export function renderLookup(lookup, turn) {
  if (!lookup || typeof lookup !== 'object' || typeof lookup.kind !== 'string') return null;
  const question = normQuote(turn.userText);
  if (lookup.kind === 'fact') {
    const expected = questionFact(question);
    if (!expected || expected.subject !== lookup.subject || expected.predicate !== lookup.predicate) return null;
    return reply(factLine(lookup.subject, lookup.predicate), 'According to the vehicle facts in this lesson.', { kind: 'fact', sourceRef: `FACT.${lookup.subject}.${lookup.predicate}` });
  }
  if (lookup.kind === 'word') {
    const word = lookup.word;
    const dictionary = turn.content?.dict || DATA.DICT;
    if (typeof word !== 'string' || !Object.hasOwn(dictionary, word) || !question.includes(word)) return null;
    const [pinyin, meaning, , source] = dictionary[word];
    const field = lookup.field || 'meaning';
    if (!['meaning', 'pinyin', 'level'].includes(field)) return null;
    const entry = HSK.w[word];
    const zh = field === 'pinyin' ? `${word}：${pinyin}。` : field === 'level' ? `${word}。` : `${word}：${meaning}。`;
    const en = field === 'level' ? entry ? `HSK ${entry[0]}. ${meaning}.` : `No level assigned in the bundled HSK subset. ${meaning}. Learn this lesson word in context.` : `${pinyin} — ${meaning}`;
    return reply(zh, en, { kind: 'dictionary', word, field, hsk: entry?.[0] ?? null, sourceRef: `content/lessons/${turn.lesson}.json#dict.${word}`, note: source || '', provenance: turn.content?.provenance?.kind || 'bundled' });
  }
  if (lookup.kind === 'grammar') {
    if (!Object.hasOwn(GRAMMAR, lookup.point)) return null;
    const entry = GRAMMAR[lookup.point];
    const valid = { ye: /也/, confirm: /对吗|确认/, ne: /呢/, hybrid: /混合动力|混动/, plug: /插电式|插电/ }[lookup.point];
    if (!entry || !valid.test(question)) return null;
    const prior = new Set(turn.history.filter((x) => x.who !== 'you').map((x) => x.zh));
    const zh = entry.variants.find((text) => !prior.has(text) && fits(text, turn)) || entry.variants.find((text) => fits(text, turn));
    return zh ? reply(zh, entry.en, { kind: 'teaching', sourceRef: entry.sourceRef }) : null;
  }
  if (lookup.kind === 'support') {
    if (!Object.hasOwn(SUPPORT, lookup.need)) return null;
    const entry = SUPPORT[lookup.need];
    const valid = { nervous: /害怕|不敢|紧张|学不会|太难|说不好|说错|不好意思/, repeat: /再说|慢|重说|重复|听不清|不会读/, goal: /学什么|学习什么|这节课|今天学/, teach: /教小龙|教你|师傅|学徒/ }[lookup.need];
    if (!entry || !valid.test(question)) return null;
    if (lookup.need === 'goal' && turn.content && !turn.content.grammar.includes('也')) {
      const word = turn.content.vocabulary.find((w) => fits(`今天学“${w}”。`, turn));
      if (!word) return null;
      return reply(`今天学“${word}”。`, `This lesson: ${turn.content.vocabulary.join(', ')}. Grammar: ${turn.content.grammar.join(', ')}.`, { kind: 'teaching', sourceRef: `content/lessons/${turn.lesson}.json#vocabulary`, provenance: turn.content.provenance.kind });
    }
    const prior = new Set(turn.history.filter((x) => x.who !== 'you').map((x) => x.zh));
    const zh = entry.variants.find((text) => !prior.has(text) && fits(text, turn)) || entry.variants.find((text) => fits(text, turn));
    return zh ? reply(zh, entry.en, { kind: 'teaching', sourceRef: entry.sourceRef }) : null;
  }
  if (lookup.kind === 'chain') {
    const character = lookup.character;
    if (typeof character !== 'string' || [...character].length !== 1 || !question.includes(character) || !Object.hasOwn(HSK.chain, character)) return null;
    const candidate = HSK.chain[character].find(([word, level]) => level <= Math.max(1, turn.level) && fits(word + '。', turn));
    if (!candidate) return null;
    return reply(candidate[0] + '。', `${candidate[2]} — ${candidate[3]}. It shares a written character; this is not a prerequisite claim.`, { kind: 'hsk-chain', sourceRef: `HSK.chain.${character}`, word: candidate[0], hsk: candidate[1] });
  }
  if (lookup.kind === 'collocation') {
    const word = lookup.word;
    if (!turn.plugged || typeof word !== 'string' || !question.includes(word)) return null;
    const items = cardFor(word, turn)?.graph?.collocations || [];
    const item = items.find((x) => typeof x.w === 'string' && DATA.EV[x.ev] && DATA.EV[x.ev].zh.includes(x.w) && !x.grey && fits(x.w + '。', turn));
    if (!item) return null;
    return reply(item.w + '。', DATA.DICT[item.w]?.[1] || '', { kind: 'snapshot-excerpt', sourceRef: `EV.${item.ev}`, retrievedAt: DATA.EV[item.ev].at }, [item.ev]);
  }
  if (lookup.kind === 'example') {
    const word = lookup.word;
    if (typeof word !== 'string' || !question.includes(word)) return null;
    const card = cardFor(word, turn);
    const cited = turn.plugged ? (card?.graph?.corpus || []).find((x) => DATA.EV[x.ev]?.zh.includes(x.zh) && fits(x.zh, turn)) : null;
    if (cited) return reply(cited.zh, '', { kind: 'snapshot-excerpt', sourceRef: `EV.${cited.ev}`, retrievedAt: DATA.EV[cited.ev].at }, [cited.ev]);
    if (card?.tb?.ex && fits(card.tb.ex, turn)) return reply(card.tb.ex, card.tb.exEn || '', { kind: 'textbook', sourceRef: card.tb.page });
    if (card?.authored?.ex && fits(card.authored.ex, turn)) return reply(card.authored.ex, '', { kind: 'authored-pending-review', sourceRef: `content/lessons/${turn.lesson}.json#cards.${word}`, note: card.authored.label || 'Authored teaching example; review pending.' });
    const hskExample = HSK.w[word];
    if (hskExample?.[3] && fits(hskExample[3], turn)) return reply(hskExample[3], hskExample[5] || '', { kind: 'hsk-example', sourceRef: `HSK.w.${word}` });
    return null;
  }
  return null;
}

/** Offline routing is explicit teaching support, not an assessment of a live model's quality. */
export function inferLookup(turn) {
  const q = normQuote(turn.userText);
  const fact = questionFact(q);
  if (fact) return { kind: 'fact', ...fact };
  if (/害怕|不敢|紧张|学不会|太难|说不好|说错|不好意思/.test(q)) return { kind: 'support', need: 'nervous' };
  if (/再说|慢一点|重说|重复|听不清/.test(q)) return { kind: 'support', need: 'repeat' };
  if (/学什么|学习什么|这节课学|今天学/.test(q)) return { kind: 'support', need: 'goal' };
  if (/怎么教小龙|教你什么|我当师傅|我是师傅/.test(q)) return { kind: 'support', need: 'teach' };
  if (/为什么.*(混合动力|混动)/.test(q)) return { kind: 'grammar', point: 'hybrid' };
  if (/为什么.*插电|插电式.*意思/.test(q)) return { kind: 'grammar', point: 'plug' };
  if (/也.*(哪|怎么用|放|位置)|怎么用.*也/.test(q)) return { kind: 'grammar', point: 'ye' };
  if (/对吗.*(怎么用|时候|什么意思)|怎么.*确认/.test(q)) return { kind: 'grammar', point: 'confirm' };
  if (/呢.*(什么意思|怎么用|对吗)|对吗.*呢/.test(q)) return { kind: 'grammar', point: 'ne' };
  if (/还有.*词|带.*字.*词|有.*字.*词/.test(q)) {
    const character = Object.keys(HSK.chain).find((c) => q.includes(c) && HSK.chain[c].length);
    if (character) return { kind: 'chain', character };
  }
  // Remove the request's grammatical scaffolding before matching a target. For example,
  // “给也一个例句” requests 也, not the longer dictionary entry 一个.
  const quoted = [...turn.userText.matchAll(/[“「『"']([^”」』"']+)[”」』"']/g)].map((m) => m[1]);
  const dictionary = turn.content?.dict || DATA.DICT;
  const targetText = q.replace(/给|一个|例句|造句|举例|搭配|词组|后面|还有什么|什么意思|英文|意思|怎么说|怎么读|拼音|读音|如何读|几级|等级|HSK/gi, ' ');
  const keys = turn.content ? Object.keys(dictionary).sort((a, b) => b.length - a.length) : wordKeys;
  const word = quoted.find((w) => Object.hasOwn(dictionary, w)) || keys.find((w) => targetText.includes(w));
  if (word) {
    if (/搭配|词组|后面.*词/.test(q)) return { kind: 'collocation', word };
    if (/例句|造句|举例/.test(q)) return { kind: 'example', word };
    if (/怎么读|拼音|读音|如何读/.test(q)) return { kind: 'word', word, field: 'pinyin' };
    if (/几级|HSK|等级/i.test(q)) return { kind: 'word', word, field: 'level' };
    if (/什么意思|是什么|什么是|什么叫|英文|意思|怎么说|怎么理解|what|mean/i.test(q)) return { kind: 'word', word, field: 'meaning' };
  }
  return null;
}

const stepScripts = {
  'dragon-why': 'dWhy', 'dragon-same': 'dSame', 'dragon-more': 'dMore', 'dragon-thanks': 'dThanks',
  'ask-more': 'cAskMore', 'open-question': 'cAsk', 'free-question': 'cAsk', 'feedback': 'bRead',
};
export function fallbackTurn(turn, reason = 'not_configured') {
  const lookup = inferLookup(turn);
  const grounded = lookup && renderLookup(lookup, turn);
  if (grounded && fits(grounded.zh, turn)) return { ok: true, source: 'script', ...grounded, overLevel: overLevel(grounded.zh, turn.level, turn.content), fallbackReason: reason };
  let line = SCRIPT[stepScripts[turn.step]];
  let intent = 'redirect';
  const fact = questionFact(turn.userText);
  if (fact) { line = { zh: factLine(fact.subject, fact.predicate), en: 'According to the vehicle facts in this lesson.' }; intent = 'answer'; }
  if (!line) line = turn.role === 'dragon' ? SCRIPT.dWhy : SCRIPT.cAsk;
  if (turn.lesson !== 'nev-l4') line = { zh: turn.role === 'dragon' ? '请师傅教我。' : '我们一起看这个词。', en: 'Let us return to the words in this lesson.' };
  // Short recovery prompts fit all levels; full scripted teaching continues in the local state machine.
  if ([...line.zh.replace(/[^\p{Script=Han}]/gu, '')].length > turn.maxChars) line = { zh: turn.role === 'dragon' ? '请师傅教我。' : '我们一起看这辆车。', en: 'Let us return to the lesson together.' };
  return { ok: true, source: 'script', intent, zh: line.zh, en: line.en || '', teacher: turn.level === 0 ? line.teacher || '' : '', overLevel: overLevel(line.zh, turn.level, turn.content), evidence: [], seal: false, fallbackReason: reason };
}

export function validateNpc(candidate, turn) {
  if (!candidate || (!candidate.lookup && typeof candidate.zh !== 'string') || !['answer', 'ask_back', 'praise', 'error_demo', 'redirect', 'refuse'].includes(candidate.intent)) return { ok: false, reason: 'invalid_output' };
  if (candidate.seal === true) return { ok: false, reason: 'invalid_seal' };
  if (candidate.lookup && candidate.fact) return { ok: false, reason: 'invalid_lookup' };
  const grounded = candidate.lookup ? renderLookup(candidate.lookup, turn) : null;
  if (candidate.lookup && (!grounded || candidate.intent !== 'answer')) return { ok: false, reason: 'invalid_lookup' };
  let zh = grounded ? grounded.zh : candidate.zh.trim();
  let evidence = [];
  if (candidate.intent === 'error_demo') {
    // Exact retrieval only. A model cannot declare a paraphrase to be a real learner quotation.
    const sample = ERROR_SAMPLES.find((entry) => turn.allowedErrors.includes(entry.id) && entry.zh === zh);
    if (!sample || turn.role !== 'dragon') return { ok: false, reason: 'unverified_error' };
    evidence = [sample.id];
  } else if (grounded) {
    evidence = grounded.evidence;
    if (Array.isArray(candidate.evidence) && candidate.evidence.some((id) => !evidence.includes(id))) return { ok: false, reason: 'unverified_evidence' };
  } else if (Array.isArray(candidate.evidence) && candidate.evidence.length) {
    return { ok: false, reason: 'unverified_evidence' };
  }
  if (candidate.fact) {
    const fact = questionFact(turn.userText);
    if (!fact || candidate.fact.subject !== fact.subject || candidate.fact.predicate !== fact.predicate || candidate.intent !== 'answer') return { ok: false, reason: 'invalid_fact' };
    zh = factLine(fact.subject, fact.predicate);
  } else if (!grounded && candidate.intent !== 'error_demo') {
    if (candidate.intent === 'answer' && !TEACHING_ANSWERS.has(zh)) return { ok: false, reason: 'unverified_answer' };
    if (/^(它|这辆车|那辆车|车)(是|有|没|不|会|能|可以|需要|在)/.test(zh) && !/[？?]$/.test(zh)) return { ok: false, reason: 'unverified_fact' };
    // Generated vehicle claims must use a structured fact lookup, never unconstrained prose.
    if (/(汽车|电池|电机|发动机|燃油|电能|插混|新能源|混合动力|充电|车轮|轮胎|公里|千米|千瓦|马力|电压|电流|续航|电量|油耗)/.test(zh) && !/[？?]$/.test(zh)) return { ok: false, reason: 'unverified_fact' };
    if (/[0-9]|[一二三四五六七八九十百千万]+\s*(伏|瓦|安|米|升|度|秒|小时)/.test(zh)) return { ok: false, reason: 'unverified_number' };
  }
  if ([...zh.replace(/[^\p{Script=Han}]/gu, '')].length > turn.maxChars || zh.length > 160) return { ok: false, reason: 'too_long', retry: true };
  const over = overLevel(zh, turn.level, turn.content);
  if (over.length > 2) return { ok: false, reason: 'too_difficult', retry: true };
  // Valid Chinese is not permission to append unchecked claims in another language.
  // Until free translations are independently validated, display only source-backed English.
  const english = grounded?.en || (candidate.fact ? renderLookup({ kind: 'fact', ...candidate.fact }, turn)?.en : '') || '';
  return { ok: true, value: { ok: true, source: 'llm', intent: candidate.intent, zh, en: english, teacher: '', overLevel: over, evidence, seal: false, ...(grounded ? { grounding: grounded.grounding } : {}) } };
}
