import { createHmac, randomInt, randomUUID } from 'node:crypto';

// Protocol sources and the deliberately narrow adapter scope are recorded in docs/TENCENT-SOE.md.
const HOST = 'soe.cloud.tencent.com';
const MAX_PCM_BYTES = 16000 * 2 * 60;
const MAX_WAV_BYTES = MAX_PCM_BYTES + 65536 + 44;
const MAX_MESSAGE_BYTES = 262144;
const VENDOR = 'tencent-soe';
const HAN = /\p{Script=Han}/u;
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const score = (value) => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const ratio = (value) => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const tag = (value) => Number.isInteger(value) && value >= 0 && value <= 4 ? value : null;
const observed = (value) => value === 0 || value === 1 || value === 3;
const toneValue = (value) => Number.isInteger(value) && value >= 1 && value <= 4;

export class SoeInputError extends Error {
  constructor(code) { super(code); this.name = 'SoeInputError'; this.code = code; }
}
const invalid = (code) => { throw new SoeInputError(code); };

/** Strict, bounded RIFF/WAVE PCM reader. No transcoding, external commands, or audio persistence. */
export function parsePcm16Wav(input) {
  if (!(input instanceof Uint8Array)) invalid('soe_invalid_wav');
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length < 44 || buffer.length > MAX_WAV_BYTES) invalid('soe_wav_size');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') invalid('soe_invalid_wav');
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) invalid('soe_wav_length');
  let offset = 12, format = false, pcm = null, chunks = 0;
  while (offset < buffer.length) {
    if (++chunks > 256 || offset + 8 > buffer.length) invalid('soe_wav_chunks');
    const id = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + (length % 2);
    if (end > buffer.length || next > buffer.length) invalid('soe_wav_chunk_length');
    if (id === 'fmt ') {
      if (format || ![16, 18].includes(length)) invalid('soe_wav_format');
      if (buffer.readUInt16LE(start) !== 1 || buffer.readUInt16LE(start + 2) !== 1
        || buffer.readUInt32LE(start + 4) !== 16000 || buffer.readUInt32LE(start + 8) !== 32000
        || buffer.readUInt16LE(start + 12) !== 2 || buffer.readUInt16LE(start + 14) !== 16
        || length === 18 && buffer.readUInt16LE(start + 16) !== 0) invalid('soe_wav_format');
      format = true;
    } else if (id === 'data') {
      if (!format || pcm || !length || length % 2) invalid('soe_wav_data');
      if (length > MAX_PCM_BYTES) invalid('soe_audio_duration');
      pcm = buffer.subarray(start, end);
    }
    offset = next;
  }
  if (!format || !pcm) invalid('soe_wav_data');
  // Do not retain a caller-owned view, WAV metadata, or another upload's shared backing buffer.
  return { pcm: Buffer.from(pcm), sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: pcm.length / 32 };
}

export function validateReferenceText(value) {
  if (typeof value !== 'string') invalid('soe_invalid_reference');
  const text = value.trim();
  if (!text || text.length > 120 || !/^[\p{Script=Han} \u3000，。！？、；：,.!?;:（）()“”‘’《》—…·]+$/u.test(text)) invalid('soe_invalid_reference');
  const count = [...text].filter((c) => HAN.test(c)).length;
  if (count < 1 || count > 30) invalid('soe_reference_length');
  return text;
}

function baseResult(referenceText = '', mode = 'read') {
  return { ok: false, vendor: VENDOR, mode, referenceText, transcript: '', transcriptSource: 'none', overall: null, words: [], seal: false };
}
function failure(reason, referenceText = '', mode = 'read', extras = {}) {
  return { ...baseResult(referenceText, mode), capability: 'unavailable', reason, ...extras };
}

function timing(word) {
  const { MemBeginTime: start, MemEndTime: end } = word;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= 60000
    ? { start: start / 1000, end: end / 1000 } : { start: null, end: null };
}
function wordResult(word) {
  if (!record(word) || typeof word.Word !== 'string' || !/^[\p{Script=Han}]{1,30}$/u.test(word.Word)) return null;
  const matchTag = tag(word.MatchTag), hasAudio = observed(matchTag);
  const measuredScore = hasAudio ? score(word.PronAccuracy) : null;
  const tone = hasAudio && measuredScore !== null && word.Tone?.Valid === true
    && toneValue(word.Tone.RefTone) && toneValue(word.Tone.HypothesisTone)
    ? { valid: true, ref: word.Tone.RefTone, got: word.Tone.HypothesisTone, ok: word.Tone.RefTone === word.Tone.HypothesisTone } : null;
  const phones = (Array.isArray(word.PhoneInfos) ? word.PhoneInfos.slice(0, 20) : []).flatMap((phone) => {
    if (!record(phone) || typeof phone.Phone !== 'string' || !/^[\p{L}\p{N}_:.-]{1,32}$/u.test(phone.Phone)) return [];
    const matchTag = tag(phone.MatchTag);
    return [{ p: phone.Phone, score: hasAudio && observed(matchTag) ? score(phone.PronAccuracy) : null, matchTag }];
  });
  const singleCharacter = [...word.Word].length === 1;
  return {
    w: word.Word, score: measuredScore, ...timing(word), matchTag, tone, wordSource: 'assessment-alignment',
    // A multi-character token's one tone observation cannot be copied onto every character.
    chars: singleCharacter ? [{ c: word.Word, pinyin: '', score: measuredScore, tone, phones }] : [],
    ...(singleCharacter ? {} : { phones }),
  };
}

/** Map final vendor fields only. Words are alignment evidence, never an independent ASR transcript. */
export function normalizeTencentResult(result, referenceText) {
  if (!record(result)) return failure('soe_invalid_result', referenceText);
  if (result.PronAccuracy === -1) return failure('soe_rejected', referenceText, 'read', { rejected: true });
  const overall = score(result.SuggestedScore), accuracy = score(result.PronAccuracy);
  if (overall === null || accuracy === null || !Array.isArray(result.Words) || result.Words.length > 120) return failure('soe_invalid_result', referenceText);
  const reference = [...referenceText]; let cursor = 0;
  const words = result.Words.map(wordResult).filter(Boolean).map((word) => {
    const token = [...word.w]; let start = -1;
    // Only literal, ordered reference matches are labelled. Added words cannot consume a
    // reference position. This is text alignment, not evidence that the learner said it.
    if (word.matchTag !== 1) for (let i = cursor; i <= reference.length - token.length; i++) {
      if (token.every((c, j) => c === reference[i + j])) { start = i; break; }
    }
    const referenceRange = start >= 0 ? { start, end: start + token.length } : null;
    if (referenceRange) cursor = referenceRange.end;
    const tone = referenceRange && [0, 3].includes(word.matchTag) ? word.tone : null;
    return { ...word, tone, referenceRange, chars: word.chars.map((c) => ({ ...c, tone, referenceIndex: referenceRange?.start ?? null, source: 'Words.Word' })) };
  });
  if (!words.some((word) => word.score !== null)) return failure('soe_no_assessable_words', referenceText, 'read', { rejected: true });
  const validTones = words.reduce((count, word) => count + word.chars.filter((c) => c.tone).length, 0);
  return {
    ...baseResult(referenceText), ok: true, capability: validTones ? 'L2' : 'pronunciation', overall, words,
    overallSource: 'SuggestedScore', alignment: 'reference-constrained', toneStatus: validTones ? 'observed' : 'unavailable',
    metrics: { accuracy, fluency: ratio(result.PronFluency), completeness: ratio(result.PronCompletion) },
  };
}

function vendorFailure(code, referenceText) {
  const reasons = { 4002: 'soe_authentication', 4003: 'soe_service_not_enabled', 4004: 'soe_quota', 4005: 'soe_billing', 4006: 'soe_concurrency', 4007: 'soe_audio_decode', 4105: 'soe_no_speech', 4108: 'soe_no_valid_speech' };
  return failure(reasons[code] || 'soe_vendor_error', referenceText, 'read', { vendorCode: code, rejected: [4105, 4108].includes(code) });
}

function signedUrl(config, referenceText, voiceId, nonce, nowMs) {
  if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce > 9999999999 || typeof voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) invalid('soe_invalid_request_id');
  const timestamp = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) invalid('soe_invalid_clock');
  const params = {
    eval_mode: 1, expired: timestamp + 300, nonce, rec_mode: 1,
    ref_text: `{::cmd{F_TDET=true}}${referenceText}`, score_coeff: config.scoreCoeff,
    secretid: config.secretId, sentence_info_enabled: 0, server_engine_type: '16k_zh',
    text_mode: 0, timestamp, voice_format: 0, voice_id: voiceId,
  };
  const keys = Object.keys(params).sort();
  const endpoint = `${HOST}/soe/api/${config.appId}`;
  const unsigned = `${endpoint}?${keys.map((key) => `${key}=${params[key]}`).join('&')}`;
  const signature = createHmac('sha1', config.secretKey).update(unsigned, 'utf8').digest('base64');
  return `wss://${endpoint}?${keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&')}&signature=${encodeURIComponent(signature)}`;
}

/** No environment reads and no automatic requests. Dependencies allow isolated, unpaid protocol tests. */
export function createTencentSoe(config = {}, dependencies = {}) {
  const settings = { scoreCoeff: 1, timeoutMs: 15000, handshakeTimeoutMs: 5000, ...config };
  const configured = typeof settings.appId === 'string' && /^\d{4,20}$/.test(settings.appId)
    && [settings.secretId, settings.secretKey].every((v) => typeof v === 'string' && /^[\x21-\x7e]{1,256}$/.test(v))
    && Number.isFinite(settings.scoreCoeff) && settings.scoreCoeff >= 1 && settings.scoreCoeff <= 4;
  const now = dependencies.now || Date.now;
  const getNonce = dependencies.nonce || (() => randomInt(1, 10000000000));
  const getVoiceId = dependencies.voiceId || randomUUID;
  const WebSocketImpl = dependencies.WebSocketImpl || globalThis.WebSocket;
  const makeSocket = dependencies.webSocketFactory || ((url) => new WebSocketImpl(url));
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? Math.min(settings.timeoutMs, 120000) : 15000;
  const handshakeTimeoutMs = Number.isFinite(settings.handshakeTimeoutMs) && settings.handshakeTimeoutMs > 0 ? Math.min(settings.handshakeTimeoutMs, timeoutMs) : Math.min(5000, timeoutMs);

  function assess({ audio, referenceText, mode = 'read', signal } = {}) {
    if (mode !== 'read') return Promise.resolve(failure('soe_unsupported_mode', '', 'open', { unsupported: true }));
    let text;
    try { text = validateReferenceText(referenceText); }
    catch (error) { return Promise.resolve(failure(error.code || 'soe_invalid_reference')); }
    if (signal?.aborted) return Promise.resolve(failure('soe_cancelled', text));
    if (!configured) return Promise.resolve(failure('soe_not_configured', text));
    if (!dependencies.webSocketFactory && typeof WebSocketImpl !== 'function') return Promise.resolve(failure('soe_websocket_unavailable', text));
    const started = now();
    return new Promise((resolve) => {
      let socket, complete = false, handshakeTimer, opened = false, ready = false, voiceId, latestSummary = null, receivedBytes = 0, messages = 0;
      const listeners = [];
      const timer = setTimeout(() => finish(failure('soe_timeout', text)), timeoutMs);
      function finish(result) {
        if (complete) return;
        complete = true;
        clearTimeout(timer); clearTimeout(handshakeTimer);
        signal?.removeEventListener('abort', onAbort);
        for (const [type, callback] of listeners) socket?.removeEventListener(type, callback);
        try { if (socket && socket.readyState !== 3) socket.close(1000, 'finished'); } catch { /* Never expose socket URL or transport error text. */ }
        resolve({ ...result, latencyMs: Math.max(0, now() - started) });
      }
      function onAbort() { finish(failure('soe_cancelled', text)); }
      function listen(type, callback) { socket.addEventListener(type, callback); listeners.push([type, callback]); }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      (async () => {
        let bytes;
        if (audio instanceof Blob) {
          if (!audio.size || audio.size > MAX_WAV_BYTES) invalid('soe_wav_size');
          bytes = new Uint8Array(await audio.arrayBuffer());
        } else if (audio instanceof Uint8Array) bytes = audio;
        else if (audio instanceof ArrayBuffer) bytes = new Uint8Array(audio);
        else invalid('soe_invalid_wav');
        if (complete) return;
        const { pcm, durationMs } = parsePcm16Wav(bytes);
        voiceId = getVoiceId();
        const url = signedUrl(settings, text, voiceId, getNonce(), now());
        if (complete) return;
        // The signed URL is intentionally kept inside this closure; no logs or diagnostic copies.
        socket = makeSocket(url);
        if (!socket || typeof socket.addEventListener !== 'function' || typeof socket.removeEventListener !== 'function' || typeof socket.send !== 'function' || typeof socket.close !== 'function') {
          finish(failure('soe_transport_unavailable', text)); return;
        }
        handshakeTimer = setTimeout(() => finish(failure('soe_handshake_timeout', text)), handshakeTimeoutMs);
        listen('open', () => { opened = true; });
        listen('error', () => finish(failure('soe_connection_error', text)));
        listen('close', () => finish(failure('soe_closed_before_final', text)));
        listen('message', (event) => {
          if (complete) return;
          try {
            if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) { finish(failure('soe_invalid_message', text)); return; }
            const size = Buffer.byteLength(event.data, 'utf8'); receivedBytes += size;
            if (size > MAX_MESSAGE_BYTES || receivedBytes > MAX_MESSAGE_BYTES * 4 || ++messages > 128) { finish(failure('soe_response_too_large', text)); return; }
            const message = JSON.parse(event.data);
            if (!record(message) || !Number.isInteger(message.code) || message.code < 0 || message.code > 99999 || message.voice_id !== voiceId
              || own(message, 'final') && ![0, 1].includes(message.final)) { finish(failure('soe_invalid_message', text)); return; }
            if (message.code !== 0) { finish(vendorFailure(message.code, text)); return; }
            if (!ready) {
              if (!opened || socket.readyState !== 1 || message.result != null || message.final === 1) { finish(failure('soe_invalid_handshake', text)); return; }
              ready = true; clearTimeout(handshakeTimer);
              socket.send(pcm); // rec_mode=1: exactly one binary audio frame.
              socket.send(JSON.stringify({ type: 'end' }));
              return;
            }
            if (message.result != null) {
              const result = typeof message.result === 'string' ? JSON.parse(message.result) : message.result;
              if (!record(result)) { finish(failure('soe_invalid_result', text)); return; }
              if (message.final === 1 || result.SentenceId === -1) latestSummary = result;
            }
            if (message.final === 1) {
              if (!latestSummary) { finish(failure('soe_missing_final_result', text)); return; }
              finish({ ...normalizeTencentResult(latestSummary, text), durationMs });
            }
          } catch { finish(failure('soe_invalid_message', text)); }
        });
      })().catch((error) => finish(failure(error instanceof SoeInputError ? error.code : 'soe_transport_unavailable', text)));
    });
  }
  return { configured: Boolean(configured), assess };
}
