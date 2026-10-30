// Small, safe Markdown renderer (escapes all HTML): headings, lists, task lists,
// tables, quotes, rules, code blocks (highlight.js when loaded), inline code/bold/italic/links.
import { esc } from './dom.js';
import { runKind } from '../ui/sandbox.js';

const BLOCK = /^\u0001(\d+)\u0001$/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const isRule = l => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
const indent = l => l.match(/^\s*/)[0].length;
const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

function inline(t) {
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_, c) => `\u0002${codes.push(c) - 1}\u0002`);
  t = esc(t)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return t.replace(/\u0002(\d+)\u0002/g, (_, n) => `<code>${esc(codes[n])}</code>`);
}

/** Syntax-highlight code to HTML (escaped fallback when highlight.js is unavailable). */
export function highlightCode(code, lang) {
  const hl = window.hljs;
  if (!hl || code.length > 60000) return esc(code);
  try {
    if (lang && hl.getLanguage(lang)) return hl.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (code.length < 15000) return hl.highlightAuto(code).value;
  } catch { /* fall through */ }
  return esc(code);
}

export const lineNumbers = n => Array.from({ length: n }, (_, i) => i + 1).join('\n');

/** IDE-style block: language, line count, actions (only once the message is final), gutter. */
function codeBlock(code, lang, final) {
  const lines = code.split('\n').length;
  const kind = runKind(lang, code);
  const actions = final
    ? `<span class="cb-act">${kind ? '<button class="cb-run" type="button" title="Run in a sandboxed frame">▶ Run</button>' : ''}` +
      '<button class="cb-edit" type="button" title="Edit this code">Edit</button>' +
      '<button class="cb-save" type="button" title="Save as a file in the workspace">Save</button>' +
      '<button class="cb-copy" type="button">Copy</button></span>'
    : '';
  return `<div class="codeblock" data-lang="${esc(lang || '')}"${kind ? ` data-run="${kind}"` : ''}>` +
    `<div class="cb-head"><span class="cb-lang">${esc(lang || 'text')}</span><span class="cb-info">${lines} line${lines === 1 ? '' : 's'}</span>${actions}</div>` +
    `<div class="cb-body"><pre class="cb-gutter" aria-hidden="true">${lineNumbers(lines)}</pre>` +
    `<pre class="cb-code"><code class="hljs">${final ? highlightCode(code, lang) : esc(code)}</code></pre></div></div>`;
}

function dedent(lines) {
  const min = Math.min(...lines.filter(l => l.trim()).map(indent));
  return lines.map(l => l.slice(Number.isFinite(min) ? min : 0)).join('\n');
}

const startsBlock = (l, next) =>
  BLOCK.test(l.trim()) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST.test(l) || isRule(l) || (isTableRow(l) && next != null && isTableSep(next));

export function renderMarkdown(src, { highlight = true } = {}) {
  const blocks = [];
  src = String(src ?? '').replace(/\r\n/g, '\n')
    .replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) =>
      `\n\u0001${blocks.push(codeBlock(code.replace(/\n$/, ''), lang, highlight)) - 1}\u0001\n`);

  const lines = src.split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
    const l = lines[i], t = l.trim();
    let m;
    if (!t) { i++; continue; }
    if (BLOCK.test(t)) { out += t; i++; continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = Math.min(6, m[1].length + 1);
      out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue;
    }
    if (isRule(l)) { out += '<hr>'; i++; continue; }
    if (isTableRow(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out += '<div class="tablewrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>';
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${renderMarkdown(q.join('\n'), { highlight })}</blockquote>`;
      continue;
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l), base = indent(l);
      let html = ordered ? '<ol>' : '<ul>';
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) { if (i + 1 < lines.length && LIST.test(lines[i + 1]) && indent(lines[i + 1]) <= base + 1) { i++; continue; } break; }
        if (!(LIST.test(cur) && indent(cur) <= base + 1)) break;
        let item = cur.replace(LIST, '');
        i++;
        const sub = [];
        while (i < lines.length && lines[i].trim() && !(LIST.test(lines[i]) && indent(lines[i]) <= base + 1) &&
          (indent(lines[i]) > base || BLOCK.test(lines[i].trim()))) sub.push(lines[i++]);
        let box = '';
        const tm = item.match(/^\[([ xX])\]\s+/);
        if (tm) { box = `<input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> `; item = item.slice(tm[0].length); }
        html += `<li>${box}${inline(item)}${sub.length ? renderMarkdown(dedent(sub), { highlight }) : ''}</li>`;
      }
      out += html + (ordered ? '</ol>' : '</ul>');
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    if (!para.length) para.push(lines[i++].trim());
    out += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return out.replace(/\u0001(\d+)\u0001/g, (m0, n) => blocks[n] ?? m0);
}
