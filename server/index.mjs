import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './canonical.mjs';
import { configuration, createServices, HttpError } from './services.mjs';

export async function readBody(req, limit = 32000) {
  const claimed = Number(req.headers['content-length']);
  if (claimed > limit) throw new HttpError(413, 'body_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'json_required');
  try { return JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'invalid_json'); }
}
const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const sameSecret = (a, b) => {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

export function createApp({ config = configuration(), fetchImpl, now, staticDir = path.join(ROOT, 'dist') } = {}) {
  const service = createServices(config, { fetchImpl, now });
  const limits = new Map();
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const rateLimit = (req) => {
    const nowMs = Date.now(), key = req.socket.remoteAddress || 'unknown';
    const entry = limits.get(key);
    if (!entry || entry.until < nowMs) {
      if (limits.size > 5000) for (const [k, e] of limits) if (e.until < nowMs) limits.delete(k);
      limits.set(key, { count: 1, until: nowMs + 60000 }); return;
    }
    if (++entry.count > 180) throw new HttpError(429, 'request_rate_limit');
  };
  const checkOrigin = (req) => {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (!localHost && (!config.publicOrigin || new URL(config.publicOrigin).host !== host)) throw new HttpError(403, 'host_not_allowed');
    if (origin && origin !== `http://${host}` && origin !== `https://${host}` && origin !== config.publicOrigin) throw new HttpError(403, 'origin_not_allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross_site_request');
  };
  const teacherAllowed = (req) => {
    if (config.teacherToken) return sameSecret(String(req.headers.authorization || ''), `Bearer ${config.teacherToken}`);
    return isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !config.publicOrigin;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      checkOrigin(req);
      if (url.pathname.startsWith('/api/')) {
        rateLimit(req);
        if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, service: 'workshop', capabilities: service.capabilities(), privacy: { audioStored: false, namesStored: false, transcriptStored: false }, evidenceSource: 'bundled-snapshot', teacherRequiresToken: Boolean(config.teacherToken || config.publicOrigin) });
        if (req.method === 'GET' && url.pathname === '/api/corpus/evidence') return send(res, 200, await service.evidence(url.searchParams.get('ev') || ''));
        if (req.method === 'GET' && url.pathname === '/api/teacher/summary') {
          if (!teacherAllowed(req)) throw new HttpError(401, 'teacher_auth_required');
          return send(res, 200, await service.summary());
        }
        if (req.method === 'POST' && url.pathname === '/api/npc/turn') return send(res, 200, await service.npc(await jsonBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/corpus/search') return send(res, 200, await service.corpusSearch(await jsonBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/learn/event') return send(res, 200, await service.event(await jsonBody(req)));
        if (req.method === 'POST' && url.pathname === '/api/speech/assess') {
          const contentType = String(req.headers['content-type'] || '');
          if (!/^multipart\/form-data;\s*boundary=.{1,200}$/.test(contentType)) throw new HttpError(415, 'multipart_required');
          const body = await readBody(req, 4_100_000);
          let form;
          try { form = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData(); }
          catch { throw new HttpError(400, 'invalid_multipart'); }
          if ([...form.keys()].length > 12) throw new HttpError(400, 'too_many_fields');
          return send(res, 200, await service.speech(form));
        }
        throw new HttpError(404, 'api_not_found');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'method_not_allowed');
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname === '/' ? '插电工坊.html' : pathname.replace(/^\/+/, '');
      const file = path.resolve(staticDir, relative);
      if (!file.startsWith(path.resolve(staticDir) + path.sep)) throw new HttpError(403, 'path_not_allowed');
      const allowed = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.spz': 'application/octet-stream', '.splat': 'application/octet-stream', '.ply': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      const contentType = allowed[path.extname(file).toLowerCase()];
      if (!contentType) throw new HttpError(404, 'file_not_found');
      const real = await fs.realpath(file);
      const realRoot = await fs.realpath(staticDir);
      const realRelative = path.relative(realRoot, real);
      if (realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new HttpError(403, 'path_not_allowed');
      const contents = await fs.readFile(real);
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': contents.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const code = e instanceof HttpError ? e.status : e.code === 'ENOENT' ? 404 : e instanceof URIError ? 400 : 500;
      send(res, code, { ok: false, error: e instanceof HttpError ? e.code : code === 404 ? 'file_not_found' : code === 400 ? 'invalid_path' : 'internal_error', fallback: 'local' });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return { server, service };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = configuration();
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 5198);
  if (!isLoopback(host) && (!config.publicOrigin || !config.teacherToken)) {
    console.error('Non-loopback hosting requires WORKSHOP_PUBLIC_ORIGIN and WORKSHOP_TEACHER_TOKEN.');
    process.exit(1);
  }
  const { server } = createApp({ config });
  server.listen(port, host, () => console.log(`插电工坊: http://${host}:${port}/ (providers are configured server-side)`));
}
