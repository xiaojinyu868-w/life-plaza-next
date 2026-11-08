// Operator-supplied public notices. Never derive them from credentials or endpoint URLs.
const label = (value, max = 240) => String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
function policyUrl(value) {
  if (!value) return '';
  let u;
  try { u = new URL(value); } catch { throw new Error('invalid_privacy_policy_url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.href.length > 500) throw new Error('invalid_privacy_policy_url');
  return u.href;
}
export function noticeConfiguration(env) {
  const provider = (kind) => ({
    name: label(env[`WORKSHOP_${kind}_PROVIDER_NAME`], 100),
    region: label(env[`WORKSHOP_${kind}_REGION`], 100),
    audioRetention: label(env[`WORKSHOP_${kind}_AUDIO_RETENTION`]),
    policyUrl: policyUrl(env[`WORKSHOP_${kind}_POLICY_URL`]),
  });
  return { operatorName: label(env.WORKSHOP_OPERATOR_NAME, 100), asr: provider('ASR'), assessment: provider('ASSESSMENT') };
}
export function privacyNotice(config, capabilities) {
  const notices = config.notices || {};
  const providers = [];
  for (const kind of ['assessment', 'asr']) if (capabilities[kind]) {
    const item = notices[kind] || {};
    const name = item.name || (kind === 'assessment' && capabilities.assessmentVendor === 'tencent-soe' ? '腾讯云语音评测（SOE）' : '');
    providers.push({ kind, name, region: item.region || '', audioRetention: item.audioRetention || '', policyUrl: item.policyUrl || '', complete: Boolean(name && item.region && item.audioRetention && item.policyUrl) });
  }
  return {
    audioStored: false, namesStored: false, transcriptStored: false,
    operatorName: notices.operatorName || '',
    events: { enabled: config.eventRetentionDays !== 0, retentionDays: config.eventRetentionDays ?? 30, maxBytes: config.eventMaxBytes ?? 67108864 },
    speech: { providers, complete: providers.every(p => p.complete) && (!providers.length || Boolean(notices.operatorName)) },
  };
}
export function validateHosting(config, capabilities) {
  if (!config.publicOrigin) return;
  let origin;
  try { origin = new URL(config.publicOrigin); } catch { throw new Error('invalid_public_origin'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== config.publicOrigin || origin.username || origin.password) throw new Error('invalid_public_origin');
  if (!privacyNotice(config, capabilities).speech.complete) throw new Error('speech_disclosure_required');
}

// Two independent windows: a shared school/proxy IP and a random learner session.
// X-Forwarded-For is deliberately not trusted. This is not authentication or a billing cap.
export function createRequestLimiter({ now = Date.now, ipLimit = 6000, sessionLimit = 180, windowMs = 60000, maxEntries = 10000 } = {}) {
  const entries = new Map();
  function take(kind, key, limit) {
    const at = now(), id = `${kind}:${key}`;
    let entry = entries.get(id);
    if (!entry || at >= entry.until || at < entry.started) {
      if (entries.size >= maxEntries) for (const [k, value] of entries) if (at >= value.until || at < value.started) entries.delete(k);
      if (!entries.has(id) && entries.size >= maxEntries) return { ok: false, code: 'rate_limit_capacity', retryAfter: 60 };
      entry = { count: 0, started: at, until: at + windowMs }; entries.set(id, entry);
    }
    if (entry.count >= limit) return { ok: false, code: kind === 'session' ? 'session_rate_limit' : 'request_rate_limit', retryAfter: Math.max(1, Math.ceil((entry.until - at) / 1000)) };
    entry.count++; return { ok: true };
  }
  return { ip: address => take('ip', address, ipLimit), session: id => take('session', id, sessionLimit) };
}
