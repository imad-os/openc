// Internet access for agents, from inside a browser (where CORS blocks most sites).
//
// web_fetch tries, in order: the page directly (works for CORS-enabled hosts such as
// raw.githubusercontent.com, jsDelivr, unpkg, many APIs) → Ollama web_fetch (needs an
// ollama.com API key) → Jina Reader r.jina.ai (free, no key needed) → your own CORS proxy.
// web_search tries: Ollama web_search (key) → Jina search (key) → your SearXNG → DuckDuckGo
// via Jina Reader (free) → Wikipedia (free).
import { state } from '../core/state.js';

const cache = new Map(); // url -> { title, content, via, t }

async function timedFetch(url, opts = {}, ms = 30000, signal) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const onAbort = () => c.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...opts, signal: c.signal, referrerPolicy: 'no-referrer' });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(c.signal.aborted ? `timed out after ${ms / 1000}s` : 'blocked or unreachable (CORS/network)');
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** HTML → readable Markdown-ish text (keeps headings, code, lists, tables, links). */
export function htmlToText(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,nav,footer,form,button,dialog,[aria-hidden="true"],[role=navigation],.sidebar,#sidebar,.toc,.navbar,.cookie,.advert').forEach(e => e.remove());
  const root = doc.querySelector('main article, article, main, [role=main], .markdown-body, .content, #content') || doc.body;
  const abs = href => { try { return new URL(href, baseUrl).href; } catch { return ''; } };
  const out = [];
  const walk = node => {
    if (node.nodeType === 3) { out.push(node.nodeValue.replace(/\s+/g, ' ')); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) { out.push('\n\n' + '#'.repeat(+tag[1]) + ' ' + node.textContent.trim() + '\n\n'); return; }
    if (tag === 'pre') { out.push('\n```\n' + node.textContent.replace(/\n+$/, '') + '\n```\n'); return; }
    if (tag === 'code') { out.push('`' + node.textContent + '`'); return; }
    if (tag === 'br') { out.push('\n'); return; }
    if (tag === 'a') {
      const text = node.textContent.trim(), href = abs(node.getAttribute('href') || '');
      out.push(text && /^https?:/.test(href) && href !== baseUrl ? `[${text}](${href})` : text);
      return;
    }
    if (tag === 'tr') { out.push('\n| ' + [...node.children].map(c => c.textContent.trim().replace(/\s+/g, ' ')).join(' | ') + ' |'); return; }
    const block = /^(p|div|section|article|ul|ol|table|blockquote|dl|dt|dd|header|main|figure)$/.test(tag);
    if (tag === 'li') out.push('\n- ');
    else if (block) out.push('\n\n');
    node.childNodes.forEach(walk);
    if (block) out.push('\n\n');
  };
  walk(root);
  const text = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: doc.title?.trim() || baseUrl, text };
}

async function direct(url, signal) {
  const r = await timedFetch(url, {}, 20000, signal);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const type = r.headers.get('content-type') || '';
  if (/image|audio|video|octet-stream|zip|pdf/.test(type)) throw new Error('not a text page (' + type + ')');
  const body = await r.text();
  if (/html/.test(type) || /^\s*<(!doctype html|html)/i.test(body)) { const { title, text } = htmlToText(body, url); return { title, content: text }; }
  return { title: url, content: body };
}

async function ollamaFetch(url, signal) {
  const key = state.settings.ollamaKey;
  if (!key) throw new Error('no ollama.com API key set');
  const r = await timedFetch('https://ollama.com/api/web_fetch', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ url }) }, 30000, signal);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const links = (j.links || []).slice(0, 40);
  return { title: j.title || url, content: (j.content || '') + (links.length ? '\n\nLinks:\n' + links.map(l => '- ' + l).join('\n') : '') };
}

async function jinaFetch(url, signal) {
  const headers = {};
  if (state.settings.jinaKey) headers.authorization = 'Bearer ' + state.settings.jinaKey;
  const r = await timedFetch('https://r.jina.ai/' + url, { headers }, 45000, signal);
  if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 429 ? ' (rate limited; add a free Jina key in Settings)' : ''));
  const text = await r.text();
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || url;
  const content = text.split(/^Markdown Content:\s*$/m)[1] ?? text;
  return { title, content: content.trim() };
}

async function proxyFetch(url, signal) {
  const tpl = state.settings.proxyUrl;
  if (!tpl) throw new Error('no proxy configured');
  const target = tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url);
  const r = await timedFetch(target, {}, 30000, signal);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const body = await r.text();
  if (/^\s*<(!doctype html|html)/i.test(body)) { const { title, text } = htmlToText(body, url); return { title, content: text }; }
  return { title: url, content: body };
}

/** Fetch a page as text. Returns { title, content, via }. */
export async function webFetch(url, signal) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60000) return hit;
  const errors = [];
  for (const [via, fn] of [['direct', direct], ['ollama', ollamaFetch], ['jina', jinaFetch], ['proxy', proxyFetch]]) {
    try {
      const r = await fn(url, signal);
      if (!r.content?.trim()) throw new Error('empty page');
      const res = { ...r, via, t: Date.now() };
      cache.set(url, res);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
      return res;
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${via}: ${e.message}`);
    }
  }
  throw new Error(`Could not fetch ${url}. Tried ${errors.join('; ')}`);
}

/* ---------------- search ---------------- */

const unwrapDdg = href => {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    return u.searchParams.get('uddg') ? decodeURIComponent(u.searchParams.get('uddg')) : u.href;
  } catch { return href; }
};

const providers = {
  async ollama(q, n, signal) {
    const key = state.settings.ollamaKey;
    if (!key) throw new Error('no ollama.com API key');
    const r = await timedFetch('https://ollama.com/api/web_search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ query: q, max_results: Math.min(10, n) }) }, 30000, signal);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return ((await r.json()).results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
  },
  async jina(q, n, signal) {
    const key = state.settings.jinaKey;
    if (!key) throw new Error('no Jina API key');
    const r = await timedFetch('https://s.jina.ai/?q=' + encodeURIComponent(q), { headers: { authorization: 'Bearer ' + key, accept: 'application/json', 'X-Respond-With': 'no-content' } }, 30000, signal);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return ((await r.json()).data || []).slice(0, n).map(x => ({ title: x.title, url: x.url, snippet: x.description || x.content?.slice(0, 300) }));
  },
  async searxng(q, n, signal) {
    const base = (state.settings.searxngUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('no SearXNG URL');
    const r = await timedFetch(`${base}/search?format=json&q=${encodeURIComponent(q)}`, {}, 20000, signal);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return ((await r.json()).results || []).slice(0, n).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
  },
  async duckduckgo(q, n, signal) {
    const { content } = await jinaFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), signal);
    const seen = new Set(), out = [];
    for (const m of content.matchAll(/\[([^\]\n]{3,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
      const url = unwrapDdg(m[2]);
      if (/duckduckgo\.com|duck\.co/.test(url) || seen.has(url) || /^(\d+|next|previous)$/i.test(m[1].trim())) continue;
      seen.add(url);
      out.push({ title: m[1].replace(/\*\*/g, '').trim(), url, snippet: '' });
      if (out.length >= n) break;
    }
    if (!out.length) throw new Error('no results parsed');
    return out;
  },
  async wikipedia(q, n, signal) {
    const r = await timedFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${n}&srsearch=${encodeURIComponent(q)}`, {}, 15000, signal);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return ((await r.json()).query?.search || []).map(x => ({
      title: x.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(x.title.replace(/ /g, '_')),
      snippet: x.snippet.replace(/<[^>]+>/g, ''),
    }));
  },
};

export async function webSearch(query, n = 8, signal) {
  const pref = state.settings.searchProvider || 'auto';
  const order = pref === 'auto' ? ['ollama', 'jina', 'searxng', 'duckduckgo', 'wikipedia'] : [pref, 'duckduckgo', 'wikipedia'];
  const errors = [];
  for (const p of [...new Set(order)]) {
    try {
      const results = await providers[p](query, n, signal);
      if (results.length) return { provider: p, results };
      errors.push(`${p}: no results`);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!/^no .*(key|URL)$/.test(e.message)) errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error('Search failed. ' + errors.join('; '));
}
