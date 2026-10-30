// Run model-written HTML / JS / SVG in a sandboxed iframe (opaque origin: no access to this
// app's storage, cookies, API keys or DOM). Console output is bridged back via postMessage.
import { h, esc } from '../util/dom.js';

export const SANDBOX = 'allow-scripts allow-modals allow-forms allow-pointer-lock allow-popups allow-downloads';

const BRIDGE = `<script>(function(){
var fmt=function(a){if(a instanceof Error)return a.stack||String(a);if(a&&typeof a==='object'){try{return JSON.stringify(a,null,2)}catch(e){}}return String(a)};
var send=function(level,args){try{parent.postMessage({__ocConsole:1,level:level,text:[].map.call(args,fmt).join(' ')},'*')}catch(e){}};
['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){send(k,arguments);if(o)o.apply(console,arguments)}});
addEventListener('error',function(e){send('error',[(e.message||'Error')+(e.lineno?' (line '+e.lineno+')':'')])});
addEventListener('unhandledrejection',function(e){send('error',['Unhandled rejection: '+fmt(e.reason)])});
})();<\/script>`;

const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';
const scriptSafe = s => String(s).replace(/<\/script/gi, '<\\/script');

/** Which runner a code block gets: 'html' | 'js' | 'svg' | null */
export function runKind(lang, code) {
  const l = String(lang || '').toLowerCase();
  if (['html', 'htm', 'xhtml'].includes(l)) return 'html';
  if (['js', 'javascript', 'mjs'].includes(l)) return 'js';
  if (l === 'svg') return 'svg';
  if (!l || l === 'xml' || l === 'text') {
    if (/^\s*<svg[\s>]/i.test(code)) return 'svg';
    if (/^\s*(<!doctype html|<html[\s>])/i.test(code)) return 'html';
  }
  return null;
}

/** Build the full document for the iframe. extras: { css, js } from sibling code blocks. */
export function buildDoc(kind, code, extras = {}) {
  if (kind === 'js') {
    return `<!doctype html><html><head><meta charset="utf-8">${VIEWPORT}${BRIDGE}<style>body{font:14px/1.5 system-ui,sans-serif;margin:12px}</style></head><body><script>\n${scriptSafe(code)}\n<\/script></body></html>`;
  }
  if (kind === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8">${VIEWPORT}${BRIDGE}<style>html,body{margin:0;height:100%;background:#fff;display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style></head><body>${code}</body></html>`;
  }
  let html = String(code);
  const head = BRIDGE + (/<meta[^>]+viewport/i.test(html) ? '' : VIEWPORT) + (extras.css ? `<style>\n${extras.css}\n</style>` : '');
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + head);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, m => m + '<head>' + head + '</head>');
  else html = '<!doctype html><meta charset="utf-8">' + head + html;
  if (extras.js) {
    const tag = `<script>\n${scriptSafe(extras.js)}\n<\/script>`;
    const i = html.toLowerCase().lastIndexOf('</body>');
    html = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
  }
  return html;
}

/** Open a document in a new tab, still inside a sandboxed iframe. */
export function openInNewTab(doc, title = 'Preview') {
  const wrapper = `<!doctype html><meta charset="utf-8">${VIEWPORT}<title>${esc(title)}</title>` +
    '<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style>' +
    `<iframe sandbox="${SANDBOX}" srcdoc="${esc(doc)}"></iframe>`;
  const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// iframe window → console element
const consoles = new Map();
window.addEventListener('message', e => {
  const el = consoles.get(e.source);
  if (!el || !e.data || e.data.__ocConsole !== 1) return;
  if (el.childElementCount > 500) el.firstChild.remove();
  el.append(h('div', { class: e.data.level }, String(e.data.text)));
  el.scrollTop = el.scrollHeight;
});

/**
 * Show (or re-run) the output panel under `host`.
 * opts: { kind, getDoc: () => string, label }
 */
export function runIn(host, { kind, getDoc, label }) {
  const existing = host.querySelector(':scope > .cb-out');
  if (existing) { existing._run(); existing.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return existing; }

  const frame = h('iframe', { class: 'cbo-frame', sandbox: SANDBOX, title: 'Sandboxed output', referrerpolicy: 'no-referrer', loading: 'eager' });
  const con = h('pre', { class: 'cbo-console' });
  const status = h('span', { class: 'grow' });
  const fullBtn = h('button', { type: 'button', title: 'Full screen' }, '⛶');
  const out = h('div', { class: 'cb-out' + (kind === 'js' ? ' js-only' : '') },
    h('div', { class: 'cbo-bar' },
      status,
      kind === 'js' ? h('button', { type: 'button', title: 'Show the page this script renders', onclick: e => { out.classList.toggle('js-only'); e.target.textContent = out.classList.contains('js-only') ? 'Show page' : 'Hide page'; } }, 'Show page') : null,
      h('button', { type: 'button', title: 'Run again', onclick: () => out._run() }, '↻ Rerun'),
      fullBtn,
      h('button', { type: 'button', title: 'Open in a new tab (still sandboxed)', onclick: () => openInNewTab(getDoc(), label) }, '↗'),
      h('button', { type: 'button', title: 'Close', onclick: () => { consoles.delete(frame.contentWindow); out.remove(); document.removeEventListener('keydown', onKey); } }, '✕')),
    frame, con);
  const onKey = e => { if (e.key === 'Escape' && out.classList.contains('full')) toggleFull(); };
  const toggleFull = () => { out.classList.toggle('full'); fullBtn.textContent = out.classList.contains('full') ? '✕ Exit full screen' : '⛶'; };
  fullBtn.addEventListener('click', toggleFull);
  document.addEventListener('keydown', onKey);
  out._run = () => {
    con.innerHTML = '';
    status.textContent = `▶ ${label} · sandboxed · ${new Date().toLocaleTimeString()}`;
    frame.srcdoc = getDoc();
  };
  host.append(out);
  consoles.set(frame.contentWindow, con);
  out._run();
  setTimeout(() => out.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  return out;
}
