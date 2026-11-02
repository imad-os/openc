// Ollama HTTP API client: requests, NDJSON streaming, retries.
import { state } from './state.js';
import { sleep } from '../util/misc.js';

export const baseUrl = url => String(url || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');

export function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return baseUrl(u);
}

export class HttpError extends Error {
  constructor(status, detail) {
    super(`HTTP ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export async function request(path, body, { signal, conn = state.conn } = {}) {
  if (!conn?.url) throw new Error('Not connected to a server');
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (conn.key) headers.authorization = 'Bearer ' + conn.key;
  let res;
  try {
    res = await fetch(baseUrl(conn.url) + path, {
      method: body ? 'POST' : 'GET', headers, signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Cannot reach ${baseUrl(conn.url)} (${e.message}). The server may be down, or the browser blocked the request (CORS / mixed content).`);
  }
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    let detail = text;
    try { detail = JSON.parse(text).error || text; } catch { /* not JSON */ }
    throw new HttpError(res.status, String(detail || res.statusText).slice(0, 500));
  }
  return res;
}

/** Iterate newline-delimited JSON objects from a streaming response. */
export async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) yield JSON.parse(l);
  }
  if (buf.trim()) yield JSON.parse(buf);
}

export async function listModels(conn = state.conn) {
  const tags = await (await request('/api/tags', null, { conn })).json();
  let running = {};
  try {
    const ps = await (await request('/api/ps', null, { conn })).json();
    running = Object.fromEntries((ps.models || []).map(m => [m.name, m]));
  } catch { /* older servers */ }
  return { models: tags.models || [], running };
}

export const showModel = (name, conn = state.conn) =>
  request('/api/show', { model: name }, { conn }).then(r => r.json());

export class StallError extends Error {
  constructor(message) { super(message); this.name = 'StallError'; }
}

const transient = e => !(e instanceof StallError) && (!(e instanceof HttpError) || [408, 425, 429, 500, 502, 503, 504].includes(e.status));
const secs = ms => Math.round(ms / 1000) + 's';

/**
 * Streaming /api/chat. Returns { content, thinking, tool_calls, stats }.
 * - Retries transient failures (network, 5xx, 429) with backoff, only if nothing was streamed yet.
 * - Watchdog: throws StallError when the first chunk takes longer than firstTokenTimeout,
 *   or when no chunk arrives for idleTimeout (ms; 0 disables).
 */
export async function chatStream(body, { signal, onChunk, onRetry, conn = state.conn, retries = 2, firstTokenTimeout = 0, idleTimeout = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let received = false;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stall = null, timer = 0;
    const arm = (ms, why) => {
      clearTimeout(timer);
      if (ms > 0) timer = setTimeout(() => { stall = why; ctrl.abort(); }, ms);
    };
    try {
      arm(firstTokenTimeout, `no response from the model for ${secs(firstTokenTimeout)}`);
      const res = await request('/api/chat', { ...body, stream: true }, { signal: ctrl.signal, conn });
      const out = { content: '', thinking: '', tool_calls: [], stats: null };
      for await (const ch of ndjson(res)) {
        if (ch.error) throw new Error(ch.error);
        received = true;
        arm(idleTimeout, `no new tokens for ${secs(idleTimeout)}`);
        const m = ch.message || {};
        if (m.thinking) out.thinking += m.thinking;
        if (m.content) out.content += m.content;
        if (m.tool_calls?.length) out.tool_calls.push(...m.tool_calls);
        onChunk?.(m, out);
        if (ch.done) out.stats = ch;
      }
      return out;
    } catch (e) {
      if (stall && !signal?.aborted) e = new StallError(stall);
      if (e.name === 'AbortError' || received || attempt >= retries || !transient(e)) throw e;
      onRetry?.(attempt + 1, e);
      await sleep(800 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export async function chatOnce(body, { signal, conn = state.conn } = {}) {
  const res = await request('/api/chat', { ...body, stream: false }, { signal, conn });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.message || {};
}

/** Models currently loaded in memory on a server: name -> { size, size_vram, expires_at } */
export async function loadedModels(conn = state.conn) {
  const ps = await (await request('/api/ps', null, { conn })).json();
  return Object.fromEntries((ps.models || []).map(m => [m.name, m]));
}
