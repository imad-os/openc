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

const transient = e => !(e instanceof HttpError) || [408, 425, 429, 500, 502, 503, 504].includes(e.status);

/**
 * Streaming /api/chat. Retries transient failures (network, 5xx, 429) with backoff,
 * but only if nothing was streamed yet. Returns { content, thinking, tool_calls, stats }.
 */
export async function chatStream(body, { signal, onChunk, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let received = false;
    try {
      const res = await request('/api/chat', { ...body, stream: true }, { signal });
      const out = { content: '', thinking: '', tool_calls: [], stats: null };
      for await (const ch of ndjson(res)) {
        if (ch.error) throw new Error(ch.error);
        received = true;
        const m = ch.message || {};
        if (m.thinking) out.thinking += m.thinking;
        if (m.content) out.content += m.content;
        if (m.tool_calls?.length) out.tool_calls.push(...m.tool_calls);
        onChunk?.(m, out);
        if (ch.done) out.stats = ch;
      }
      return out;
    } catch (e) {
      if (e.name === 'AbortError' || received || attempt >= retries || !transient(e)) throw e;
      await sleep(800 * 2 ** attempt, signal);
    }
  }
}

export async function chatOnce(body, { signal } = {}) {
  const res = await request('/api/chat', { ...body, stream: false }, { signal });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.message || {};
}
