/* Measured pronunciation feedback. Recognition and reference alignment stay separate. */
(function (G) {
  'use strict';
  const clean = s => String(s || '').trim();
  const TONES = {
    1: ['一声', '保持高音，平着读。', 'Keep the pitch high and level.'],
    2: ['二声', '声音从低往高扬。', 'Let the pitch rise.'],
    3: ['三声', '先把声音压低；连读时听整词示范。', 'Start low; listen to the whole word in context.'],
    4: ['四声', '从高往低落，干脆一点。', 'Start high and let the pitch fall.'],
  };
  function describe(result, referenceText = '', vocabulary = []) {
    const reference = clean(referenceText).slice(0, 200);
    const transcript = result?.ok && result.transcriptSource === 'recognition' ? clean(result.transcript).slice(0, 1000) : '';
    const observed = [];
    if (result?.ok && result.capability === 'L2' && result.mode === 'read' && reference) {
      for (const word of (Array.isArray(result.words) ? result.words : []).slice(0, 100)) {
        const w = clean(word?.w);
        if (!w || !reference.includes(w)) continue;
        for (const c of (Array.isArray(word.chars) ? word.chars : []).slice(0, 50)) {
          const t = c?.tone, char = clean(c?.c);
          if (!char || !w.includes(char) || !t || t.valid !== true || !TONES[t.ref] || !TONES[t.got]) continue;
          const lessonWord = (Array.isArray(vocabulary) ? vocabulary : []).filter(v => typeof v === 'string' && v.includes(char) && reference.includes(v)).sort((a,b) => b.length-a.length)[0];
          observed.push({ char, word: lessonWord || w, ref: t.ref, got: t.got });
        }
      }
    }
    const issues = observed.filter(t => t.ref !== t.got).slice(0, 2).map(t => ({
      ...t, title: `“${t.char}” · ${TONES[t.ref][0]}`,
      instruction: TONES[t.ref][1], en: TONES[t.ref][2],
      drills: [...new Set([t.char, t.word, reference])],
    }));
    const measured = observed.length > 0;
    return {
      reference, transcript, canSubmit: !!transcript, measured, issues,
      score: measured && Number.isFinite(result.overall) && result.overall >= 0 && result.overall <= 100 ? Math.round(result.overall) : null,
      title: measured ? (issues.length > 1 ? '先练这两个声音' : issues.length ? '再练这一个声音' : '听一遍，再读一遍') : '听到你说了',
      note: measured ? '本次可评测的声调反馈；句意仍由本题单独检查。' : '本次只识别文字，没有声调评测。',
      drills: issues.length ? issues[0].drills : reference ? [reference] : [],
    };
  }
  G.CDG_PRONUNCIATION = { describe };
  if (typeof module !== 'undefined') module.exports = G.CDG_PRONUNCIATION;
})(typeof window !== 'undefined' ? window : globalThis);
