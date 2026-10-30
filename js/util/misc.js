// Generic helpers with no DOM or app-state dependencies.

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const parseArgs = a => {
  if (a && typeof a === 'object') return a;
  try { const v = JSON.parse(a || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/** Cut a long string and say how much was cut. */
export const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
};

export const firstLine = (t, n = 140) => {
  const l = String(t ?? '').trim().split('\n')[0];
  return l.length > n ? l.slice(0, n) + '…' : l;
};

/** Stable, synchronous 64-bit-ish hash as hex (doc ids; works without a secure context). */
export function hashId(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Tokens per second from accumulated model stats. */
export const tps = m => (m?.evalNs ? m.evalTokens / (m.evalNs / 1e9) : 0);

export const fmt = {
  gb: n => (n / 1e9).toFixed(1) + ' GB',
  ctx: n => (n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 1 : 0) + 'M' : n >= 1024 ? Math.round(n / 1024) + 'k' : String(n)),
  num: n => Number(n || 0).toLocaleString(),
  dur: ms => (ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's'),
  ago: ts => {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  },
};
