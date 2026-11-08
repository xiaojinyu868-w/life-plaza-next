/* Vocabulary bands only. Readings/meanings are auxiliary, never level evidence. */
(function (G) {
  'use strict';
  const BANDS = ['1', '2', '3', '4', '5', '6', '7-9'], END = Symbol('word');
  const HAN = /\p{Script=Han}/u, CONTROL = /[\u0000-\u001f\u007f]/u;
  const limits = { words: 20000, records: 40000, chars: 8000000, text: 100000, word: 128, dictionary: 5000 };
  function fail(code = 'lexicon_invalid_data') { const e = new TypeError(code); e.code = code; throw e; }
  function field(o, key) {
    if (!o || typeof o !== 'object') fail();
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d && !Object.hasOwn(d, 'value')) fail();
    return d?.value;
  }
  function list(a, max) {
    if (!Array.isArray(a)) fail();
    const length = field(a, 'length'); if (length > max) fail();
    const copy = [];
    // Index only: a caller-supplied iterator must not bypass the bounded length.
    for (let i = 0; i < length; i++) copy.push(field(a, String(i)));
    return copy;
  }
  function string(s, max, empty = false) {
    if (typeof s !== 'string' || s.length > max || (!empty && !s.trim()) || CONTROL.test(s)) fail();
    return s;
  }
  const band = b => { if (!BANDS.includes(b)) fail(); return b; };
  const sorted = values => BANDS.filter(b => values.has(b));
  function add(root, word) {
    let node = root;
    for (const c of word) { if (!node.has(c)) node.set(c, new Map()); node = node.get(c); }
    node.set(END, word);
  }
  function match(root, text, start, limit = text.length) {
    let node = root, hit = null;
    for (let i = start; i < limit;) {
      const c = String.fromCodePoint(text.codePointAt(i)); i += c.length;
      node = node.get(c); if (!node) break;
      if (node.has(END)) hit = node.get(END);
    }
    return hit;
  }
  function create(data) {
    if (field(data, 'schemaVersion') !== 1) fail();
    const rows = list(field(data, 'words'), limits.words), collected = new Map(), trie = new Map();
    let chars = 0, records = 0;
    const bounded = (s, max) => { string(s, max); chars += s.length; if (chars > limits.chars) fail('lexicon_limit'); return s; };
    for (const row of rows) {
      const word = bounded(field(row, 'word'), limits.word);
      if (/\s/u.test(word)) fail();
      let item = collected.get(word);
      if (!item) { item = { main: new Set(), usage: new Set(), readings: new Set(), meanings: new Set() }; collected.set(word, item); }
      const entries = list(field(row, 'records'), 32); if (!entries.length) fail();
      records += entries.length; if (records > limits.records) fail('lexicon_limit');
      for (const record of entries) {
        const serial = field(record, 'serial');
        if (!(Number.isSafeInteger(serial) && serial > 0) && !(typeof serial === 'string' && /^[1-9]\d{0,8}$/.test(serial))) fail();
        item.main.add(band(field(record, 'band')));
        for (const b of list(field(record, 'usageBands') ?? [], 7)) item.usage.add(band(b));
      }
      for (const key of ['readings', 'meanings']) {
        for (const value of list(field(row, key) ?? [], 32)) item[key].add(bounded(value, key === 'readings' ? 256 : 2048));
      }
    }
    const table = new Map();
    for (const [word, item] of collected) {
      const mainBands = sorted(item.main), usageBands = sorted(item.usage), bands = sorted(new Set([...mainBands, ...usageBands]));
      const ambiguous = bands.length > 1;
      const label = 'HSK ' + bands.map(b => b === '7-9' ? '7–9' : b).join(' / ') + '级词汇'
        + (ambiguous ? '（不同用法，需结合语境）' : '');
      const entry = { band: mainBands.length === 1 ? mainBands[0] : null, bands, mainBands, usageBands, ambiguous,
        maxLevel: Number(bands.at(-1).split('-')[0]), label, readings: [...item.readings], meanings: [...item.meanings] };
      for (const value of Object.values(entry)) if (Array.isArray(value)) Object.freeze(value);
      table.set(word, Object.freeze(entry)); add(trie, word);
    }
    const entry = word => typeof word === 'string' ? table.get(word) || null : null;
    function optionsOf(options) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('lexicon_invalid_options');
      const dictionary = field(options, 'dictionary') ?? {}, professionalWords = field(options, 'professionalWords') ?? [];
      if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) fail('lexicon_invalid_options');
      const keys = Object.keys(dictionary); if (keys.length > limits.dictionary) fail('lexicon_limit');
      const local = new Map(), professional = new Set(), protectedTrie = new Map();
      for (const word of keys) {
        string(word, limits.word); if (/\s/u.test(word)) fail();
        const value = field(dictionary, word), array = Array.isArray(value);
        const py = field(value, array ? '0' : 'py'), en = field(value, array ? '1' : 'en'), tag = field(value, array ? '2' : 'tag');
        if (py !== undefined) string(py, 1024, true);
        if (en !== undefined) string(en, 4096, true);
        if (tag !== undefined) string(tag, 32, true);
        local.set(word, { py, en, tag }); if (tag === 'm') add(protectedTrie, word);
      }
      for (const word of list(professionalWords, limits.dictionary)) {
        string(word, limits.word); if (/\s/u.test(word)) fail();
        professional.add(word); add(protectedTrie, word);
      }
      return { local, professional, protectedTrie };
    }
    function segment(text, options = {}) {
      if (typeof text !== 'string') fail('lexicon_invalid_text');
      if (text.length > limits.text) fail('lexicon_limit');
      const { local, professional, protectedTrie } = optionsOf(options), out = [], spans = [];
      // Reserve course terms first, even where an ordinary word would overlap them.
      for (let i = 0; i < text.length;) {
        const hit = match(protectedTrie, text, i);
        if (hit) { spans.push({ start: i, word: hit }); i += hit.length; }
        else i += String.fromCodePoint(text.codePointAt(i)).length;
      }
      function token(t) {
        const e = entry(t), d = local.get(t), zh = HAN.test(t);
        return { t, zh, py: d?.py || e?.readings.join(' / ') || '', en: d?.en || e?.meanings.join('; ') || '',
          tag: d?.tag || (e ? 'hsk' : zh ? '?' : ''), entry: e, professional: professional.has(t) };
      }
      let span = 0;
      for (let i = 0; i < text.length;) {
        if (spans[span]?.start === i) { const word = spans[span++].word; out.push(token(word)); i += word.length; continue; }
        const limit = spans[span]?.start ?? text.length, hit = match(trie, text, i, limit);
        if (hit) { out.push(token(hit)); i += hit.length; continue; }
        const c = String.fromCodePoint(text.codePointAt(i));
        if (HAN.test(c)) { out.push(token(c)); i += c.length; continue; }
        let j = i + c.length;
        while (j < limit) {
          const next = String.fromCodePoint(text.codePointAt(j));
          if (HAN.test(next) || match(trie, text, j, limit)) break;
          j += next.length;
        }
        out.push(token(text.slice(i, j))); i = j;
      }
      return out;
    }
    function inspect(text, level, options) {
      if (level === '7-9') level = 7;
      if (!Number.isInteger(level) || level < 0 || level > 9) fail('lexicon_invalid_level');
      return segment(text, options).map(t => ({ ...t, over: level !== 0 && t.zh && (!t.entry || t.entry.maxLevel > level) }));
    }
    return Object.freeze({ entry, segment, inspect });
  }
  G.CDG_LEXICON = { create };
  if (typeof module !== 'undefined') module.exports = G.CDG_LEXICON;
})(typeof window !== 'undefined' ? window : globalThis);
