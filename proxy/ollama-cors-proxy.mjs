#!/usr/bin/env node
// Ollama CORS proxy: lets a website talk to Ollama without changing OLLAMA_ORIGINS.
// Zero dependencies, Node 18+. Streams replies (chat tokens arrive live).
//
//   node ollama-cors-proxy.mjs                         # proxy on :11435 → http://127.0.0.1:11434
//   node ollama-cors-proxy.mjs --port 8080 --target http://192.168.1.20:11434
//   node ollama-cors-proxy.mjs --host 0.0.0.0          # reachable from other devices on your network
//   node ollama-cors-proxy.mjs --origin https://imad-os.github.io   # only allow this website
//
// In Ollama Code tick "Use CORS proxy" and enter http://localhost:11435 (or this machine's address).
// Request forms understood:
//   /api/tags                              → forwarded to --target
//   /http://host:11434/api/tags            → forwarded to that URL (private/loopback hosts or --allow list)
//   /?url=http%3A%2F%2Fhost%3A11434%2Fapi  → same, as a query parameter
import http from 'node:http';
import https from 'node:https';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
if (args.help || args.h) {
  console.log('Usage: node ollama-cors-proxy.mjs [--port 11435] [--host 127.0.0.1] [--target http://127.0.0.1:11434] [--origin *] [--allow host1,host2] [--any]');
  process.exit(0);
}
const PORT = +(args.port || process.env.PORT || 11435);
const HOST = args.host || process.env.HOST || '127.0.0.1';
const TARGET = new URL(args.target || process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const ORIGINS = String(args.origin || process.env.ALLOW_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW = new Set(String(args.allow || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const ANY = args.any === 'true';

const isPrivate = h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i.test(h) || h.endsWith('.local');

function allowedOrigin(origin) {
  if (ORIGINS.includes('*')) return origin || '*';
  return ORIGINS.includes(origin) ? origin : null;
}

function resolveTarget(reqUrl) {
  const u = new URL(reqUrl, 'http://proxy');
  let full = null;
  if (/^\/https?:\/\//i.test(u.pathname + u.search) || /^\/https?:\//i.test(u.pathname)) full = decodeURIComponent(reqUrl.slice(1)).replace(/^(https?:)\/(?!\/)/i, '$1//');
  else if (u.searchParams.get('url')) full = u.searchParams.get('url');
  if (!full) return new URL(reqUrl, TARGET);
  const t = new URL(full);
  const host = t.hostname.toLowerCase();
  if (!(ANY || host === TARGET.hostname.toLowerCase() || ALLOW.has(host) || isPrivate(host))) {
    throw Object.assign(new Error(`target host ${host} not allowed (use --allow ${host} or --any)`), { status: 403 });
  }
  return t;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const ok = allowedOrigin(origin);
  const cors = {
    'access-control-allow-origin': ok || 'null',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type, authorization',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (origin && !ok) { res.writeHead(403, cors); return res.end(`origin ${origin} not allowed`); }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  let target;
  try { target = resolveTarget(req.url); } catch (e) { res.writeHead(e.status || 400, { ...cors, 'content-type': 'text/plain' }); return res.end(e.message); }

  const headers = { ...req.headers, host: target.host };
  for (const h of ['origin', 'referer', 'connection', 'access-control-request-method', 'access-control-request-headers', 'access-control-request-private-network']) delete headers[h];
  const lib = target.protocol === 'https:' ? https : http;
  const started = Date.now();
  const up = lib.request(target, { method: req.method, headers }, upRes => {
    const out = { ...upRes.headers, ...cors, 'cache-control': 'no-cache', 'x-accel-buffering': 'no' };
    for (const h of Object.keys(upRes.headers)) if (h.startsWith('access-control-')) delete out[h];
    res.writeHead(upRes.statusCode || 502, out);
    res.flushHeaders?.();
    upRes.pipe(res);
    upRes.on('end', () => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${target.href} → ${upRes.statusCode} ${Date.now() - started}ms`));
  });
  up.setTimeout(0);
  up.on('error', e => {
    console.log(`${req.method} ${target.href} ✗ ${e.code || e.message}`);
    if (!res.headersSent) res.writeHead(502, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy could not reach ${target.origin}: ${e.code || e.message}` }));
  });
  req.on('aborted', () => up.destroy()); // client pressed Stop → stop generation upstream
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, HOST, () => {
  console.log(`Ollama CORS proxy on http://${HOST}:${PORT} → ${TARGET.origin}`);
  console.log(`Allowed origins: ${ORIGINS.join(', ')}${HOST === '127.0.0.1' ? '   (local only; use --host 0.0.0.0 for other devices)' : ''}`);
});
