/* Optional network capabilities. The lesson never depends on a request finishing. */
(function (G) {
  'use strict';
  function createClient({ fetchImpl = G.fetch && G.fetch.bind(G), clock = Date.now, randomUUID = () => G.crypto.randomUUID() } = {}) {
    let enabled = false;
    const active = new Set();
    const sessionId = 's_' + randomUUID().replace(/-/g, '');
    async function request(path, body, timeoutMs = 2800) {
      if (!enabled || !fetchImpl) throw new Error('offline');
      const ctl = new AbortController(); active.add(ctl);
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, timeoutMs); });
        const operation = fetchImpl(path, {
          method: body === undefined ? 'GET' : 'POST', signal: ctl.signal,
          headers: body && !(typeof FormData !== 'undefined' && body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
          body: body === undefined ? undefined : typeof FormData !== 'undefined' && body instanceof FormData ? body : JSON.stringify(body),
        }).then(async response => {
          if (!response.ok) throw new Error('http_' + response.status);
          return response.json();
        });
        const value = await Promise.race([operation, timeout]);
        if (!enabled) throw new Error('offline');
        return value;
      } finally { clearTimeout(timer); active.delete(ctl); }
    }
    return {
      sessionId,
      get enabled() { return enabled; },
      setEnabled(on) { enabled = !!on; if (!enabled) { active.forEach(c => c.abort()); active.clear(); } },
      request,
      async turn(context, fallback) {
        try {
          const result = await request('/api/npc/turn', { ...context, sessionId }, 2800);
          if (!result.ok || typeof result.zh !== 'string' || !result.zh.trim() || result.seal !== false) throw new Error('invalid_turn');
          return result;
        } catch (_) { return { ok: true, source: 'script', ...fallback, evidence: [], seal: false, fallbackReason: enabled ? 'service_unavailable' : 'offline' }; }
      },
      async event(lesson, type, payload) {
        if (!enabled) return false;
        try { const r = await request('/api/learn/event', { sessionId, lesson, t: clock(), type, payload }, 1800); return r.ok === true; }
        catch (_) { return false; }
      },
    };
  }
  G.CDG_NET = { createClient };
  if (typeof module !== 'undefined') module.exports = G.CDG_NET;
})(typeof window !== 'undefined' ? window : globalThis);
