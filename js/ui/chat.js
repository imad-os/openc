// Chat rendering: message blocks (streaming text + thinking), tool cards (approve / ask),
// notes, run summary footer, and re-rendering a stored conversation.
import { $, h, esc, toast, promptDialog, confirmDialog } from '../util/dom.js';
import { renderMarkdown, highlightCode, lineNumbers } from '../util/markdown.js';
import { parseArgs, fmt, firstLine } from '../util/misc.js';
import { state, emit } from '../core/state.js';
import { normPath } from '../core/fs.js';
import { display } from './display.js';
import { buildDoc, runIn } from './sandbox.js';

const isErrText = t => /^(Error|Denied|Interrupted)/.test(String(t || ''));
const prefixLines = (t, p) => String(t ?? '').split('\n').map(l => p + l).join('\n');
const pre = (t, cls = '') => `<pre class="${cls}">${esc(t)}</pre>`;

export function toolTitle(name, a = {}) {
  switch (name) {
    case 'list_files': return a.path || '.';
    case 'find_files': return a.pattern || '';
    case 'read_file': return (a.path || '') + (a.offset > 1 ? ` (from line ${a.offset})` : '');
    case 'write_file': case 'edit_file': case 'delete_file': return a.path || '';
    case 'move_file': return `${a.from || ''} → ${a.to || ''}`;
    case 'grep': return `/${a.pattern || ''}/` + (a.path ? ' in ' + a.path : '') + (a.include ? ' ' + a.include : '');
    case 'run_js': return firstLine(a.code, 80);
    case 'todo_write': return `${Array.isArray(a.todos) ? a.todos.length : 0} items`;
    case 'ask_user': return firstLine(a.question, 100);
    case 'task': return `${a.agent || ''}: ${firstLine(a.prompt, 90)}`;
    default: return '';
  }
}

function toolPreview(name, a = {}) {
  switch (name) {
    case 'write_file': {
      const lines = String(a.content ?? '').split('\n');
      return `<div class="dim small">${esc(a.path)} · ${lines.length} lines</div>` + pre(lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… ${lines.length - 60} more lines` : ''));
    }
    case 'edit_file':
      return `<div class="dim small">${esc(a.path)}${a.replace_all ? ' · replace all' : ''}</div><pre class="diff"><span class="del">${esc(prefixLines(a.old_string, '- '))}</span>\n<span class="add">${esc(prefixLines(a.new_string, '+ '))}</span></pre>`;
    case 'run_js': return pre(a.code ?? '');
    case 'task': return `<div class="dim small">subagent: ${esc(a.agent)}</div>` + pre(a.prompt ?? '');
    case 'todo_write':
      return '<ul class="todo-prev">' + (Array.isArray(a.todos) ? a.todos : []).map(t => `<li class="${esc(t?.status)}">${esc(t?.content)}</li>`).join('') + '</ul>';
    case 'ask_user': return '';
    default: return pre(JSON.stringify(a, null, 2));
  }
}

/** Auto-scroll that sticks to the bottom unless the user scrolled up. */
function scroller(el) {
  if (!el._scroll) {
    el._stick = true;
    el.addEventListener('scroll', () => { el._stick = el.scrollHeight - el.scrollTop - el.clientHeight < 160; });
    el._scroll = force => { if (force || el._stick) { el.scrollTop = el.scrollHeight; if (force) el._stick = true; } };
  }
  return el._scroll;
}

export function createView(root, scrollEl = root) {
  const down = scroller(scrollEl);
  const view = {
    root,
    scroll: down,
    clear() { root.innerHTML = ''; },
    user(m) {
      const el = h('div', { class: 'msg user' }, m.content);
      if (m.images?.length) m.images.forEach(b => el.append(h('img', { src: 'data:image/png;base64,' + b, alt: 'attachment' })));
      else if (m._n) el.append(h('div', { class: 'dim small' }, `[${m._n} image${m._n > 1 ? 's' : ''} attached]`));
      root.append(el); down(true);
      return el;
    },
    note(text, cls = '') { const el = h('div', { class: 'note ' + cls }, text); root.append(el); down(); return el; },
    error(text) { const el = h('div', { class: 'errline' }, text); root.append(el); down(true); return el; },
    block(label) { return makeBlock(root, label, down, scrollEl); },
    footer(run, answer) {
      const files = run.files || [];
      const parts = [`in ${fmt.dur(run.duration)}`, `${run.steps} step${run.steps === 1 ? '' : 's'}`, `${run.toolCalls} tool call${run.toolCalls === 1 ? '' : 's'}`];
      if (run.toolErrors) parts.push(`${run.toolErrors} failed`);
      if (run.tokens) parts.push(`${fmt.num(run.tokens)} tokens`);
      if (run.tps) parts.push(`${run.tps.toFixed(1)} tok/s`);
      const el = h('div', { class: 'runfoot' },
        h('div', { class: 'rf-line' },
          run.stopped ? h('span', { class: 'rf-stop' }, '■ Stopped') : run.finished === false ? h('span', { class: 'rf-stop' }, '◐ Incomplete') : h('span', { class: 'rf-ok' }, '✓ Done'),
          h('span', {}, parts.join(' · ')),
          answer ? h('button', { class: 'btn sm ghost', type: 'button', onclick: e => { navigator.clipboard?.writeText(answer); e.target.textContent = 'Copied'; } }, 'Copy answer') : null),
        files.length ? h('div', { class: 'rf-files' }, files.map(([p, kind]) =>
          h('button', { class: 'fchip ' + kind, type: 'button', title: kind, disabled: kind === 'deleted', onclick: () => emit('open-file', p) },
            (kind === 'created' ? '+ ' : kind === 'deleted' ? '− ' : '~ ') + p))) : null);
      root.append(el); down();
      return el;
    },
  };
  return view;
}

/**
 * Latest section title from a model's reasoning, e.g. "**Analyze the input:**",
 * "## Plan", "1. **Check files**". Shown next to "Thinking" while it is collapsed.
 */
export function thinkingTitle(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const m = l.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)?\*\*([^*\n]{2,90}?)\*\*/) || l.match(/^\s*#{1,4}\s+(.{2,90})$/);
    if (m) return m[1].replace(/[:：.]\s*$/, '').trim();
  }
  return '';
}

function makeThinking(started) {
  const label = h('span', { class: 'tk-label' }, 'Thinking');
  const title = h('span', { class: 'tk-title' });
  const body = h('div', { class: 'think-body md' });
  const el = h('details', { class: 'think', hidden: true }, h('summary', { title: 'Show / hide reasoning' }, label, title), body);
  let value = '', dirty = false, raf = 0, userToggled = false, autoOpened = false;
  const render = () => { raf = 0; dirty = false; body.innerHTML = renderMarkdown(value, { highlight: false }); };
  el.querySelector('summary').addEventListener('click', () => { userToggled = true; });
  el.addEventListener('toggle', () => { if (el.open && dirty) render(); });
  return {
    el,
    update(t, { done = false } = {}) {
      if (!t) return;
      value = t;
      el.hidden = false;
      const tt = thinkingTitle(t);
      title.textContent = tt ? '· ' + tt : '';
      if (done) { label.textContent = 'Thought'; }
      else {
        el.classList.add('live');
        if (!userToggled && !autoOpened && display.thinking !== 'collapsed') { el.open = true; autoOpened = true; }
      }
      if (display.thinking === 'expanded' && !userToggled) el.open = true;
      dirty = true;
      if (el.open && !raf) raf = requestAnimationFrame(render);
    },
    /** The answer started (or the message ended): stop the "live" state. */
    end() {
      if (el.hidden || !el.classList.contains('live')) return;
      el.classList.remove('live');
      label.textContent = `Thought for ${fmt.dur(Date.now() - started)}`;
      if (display.thinking === 'live' && !userToggled) el.open = false;
      if (el.open) render();
    },
  };
}

function makeBlock(parent, label, down, scrollEl) {
  const el = h('div', { class: 'msg asst live' });
  const head = h('div', { class: 'who' }, label);
  const started = Date.now();
  const think = makeThinking(started);
  const text = h('div', { class: 'md' });
  const tools = h('div', { class: 'tools' });
  el.append(head, think.el, text, tools);
  parent.append(el);
  let raf = 0, value = '';
  const paint = final => { raf = 0; text.innerHTML = renderMarkdown(value, { highlight: final }); down(); };
  return {
    el,
    thinking(t, opts) { think.update(t, opts); down(); },
    text(t, final) {
      value = t || '';
      if (value) think.end();
      if (final) { cancelAnimationFrame(raf); paint(true); }
      else if (!raf) raf = requestAnimationFrame(() => paint(false));
    },
    badge(t) { head.append(h('span', { class: 'badge' }, t)); },
    tool(call) { think.end(); const c = makeToolCard(call, down, scrollEl); tools.append(c.el); down(); return c; },
    finish() {
      if (raf) { cancelAnimationFrame(raf); paint(true); }
      think.end();
      el.classList.remove('live');
      if (!value.trim() && think.el.hidden && !tools.children.length) el.remove();
    },
  };
}

function makeToolCard(call, down, scrollEl) {
  const name = call.function?.name || '?';
  const st = h('span', { class: 'st pending' });
  const title = h('span', { class: 'tt' });
  const meta = h('span', { class: 'tmeta' });
  const argsEl = h('div', { class: 'targs' });
  const action = h('div', { class: 'tact' });
  const sub = h('div', { class: 'sub' });
  const res = h('pre', { class: 'tres', hidden: true });
  const el = h('div', { class: 'tool' },
    h('div', { class: 'th', onclick: () => el.classList.toggle('open') }, st, h('b', {}, name), title, meta),
    h('div', { class: 'tb' }, argsEl, action, sub, res));
  let t0 = 0;
  const card = {
    el, name,
    args(a) { title.textContent = toolTitle(name, a); argsEl.innerHTML = toolPreview(name, a); },
    status(s) {
      st.className = 'st ' + s;
      if (s === 'running') t0 = Date.now();
      if ((s === 'ok' || s === 'err') && t0) meta.textContent = fmt.dur(Date.now() - t0);
    },
    result(t) {
      t = String(t ?? '');
      res.textContent = t.length > 6000 ? t.slice(0, 6000) + `\n… (${t.length - 6000} more chars)` : t;
      res.hidden = !t;
    },
    open(v = true) { el.classList.toggle('open', v); },
    subView() { return createView(sub, scrollEl); },
    /** Resolves 'allow' | 'always' | 'deny'. */
    confirm(kind, signal) {
      return new Promise(resolve => {
        el.classList.add('open', 'waiting');
        const done = v => { action.innerHTML = ''; el.classList.remove('waiting'); resolve(v); };
        action.append(h('div', { class: 'perm' },
          h('span', {}, kind === 'exec' ? 'Run this code?' : 'Allow this change?'),
          h('button', { class: 'btn ok sm', type: 'button', onclick: () => done('allow') }, 'Allow'),
          h('button', { class: 'btn sm', type: 'button', title: kind === 'edit' ? 'Auto-accept file edits from now on' : 'Auto-accept everything from now on', onclick: () => done('always') }, kind === 'edit' ? 'Always allow edits' : 'Always allow'),
          h('button', { class: 'btn danger sm', type: 'button', onclick: () => done('deny') }, 'Deny')));
        signal?.addEventListener('abort', () => done('deny'), { once: true });
        down(true);
      });
    },
    ask(question, options, signal) {
      return new Promise(resolve => {
        el.classList.add('open', 'waiting');
        const input = h('input', { placeholder: 'Type your answer…' });
        const done = v => { action.innerHTML = ''; el.classList.remove('waiting'); action.append(h('div', { class: 'answer' }, '↳ ' + v)); resolve(v); };
        action.append(h('div', { class: 'ask' },
          h('div', { class: 'q' }, question),
          options?.length ? h('div', { class: 'opts' }, options.map(o => h('button', { class: 'btn sm', type: 'button', onclick: () => done(o) }, o))) : null,
          h('form', { class: 'ask-row', onsubmit: e => { e.preventDefault(); if (input.value.trim()) done(input.value.trim()); } },
            input, h('button', { class: 'btn sm primary' }, 'Answer'))));
        signal?.addEventListener('abort', () => done('(no answer: the run was stopped)'), { once: true });
        setTimeout(() => input.focus());
        down(true);
      });
    },
  };
  card.args(parseArgs(call.function?.arguments));
  return card;
}

/** Re-render a stored conversation. */
export function renderThread(view, messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') { if (m._auto) view.note('↻ ' + firstLine(m.content, 90), 'auto'); else view.user(m); continue; }
    if (m.role !== 'assistant') continue;
    const b = view.block(m._agent || 'assistant');
    if (m.thinking) b.thinking(m.thinking, { done: true });
    b.text(m.content || '', true);
    for (const call of m.tool_calls || []) {
      const card = b.tool(call);
      const next = messages[i + 1];
      if (next?.role === 'tool') { i++; card.result(next.content); card.status(isErrText(next.content) ? 'err' : 'ok'); }
      else card.status('err');
    }
    b.finish();
    if (m._run) view.footer(m._run, m.content);
  }
}

let mainView = null;
export const getMainView = () => (mainView ||= createView($('#chat')));

/* ---------- code block actions: Run (sandboxed), Edit, Save, Copy ---------- */

const codeOf = block => block.querySelector('.cb-edit-area')?.value ?? block.querySelector('.cb-code code').textContent;
const langOf = block => (block.dataset.lang || '').toLowerCase();
const flash = (btn, text) => { const old = btn.textContent; btn.textContent = text; setTimeout(() => { btn.textContent = old; }, 1200); };

/** CSS / JS blocks from the same message, merged into an HTML run when the page doesn't inline its own. */
function siblingAssets(block, html) {
  const md = block.closest('.md');
  if (!md) return {};
  const others = [...md.querySelectorAll(':scope > .codeblock, :scope .codeblock')].filter(b => b !== block);
  const pick = langs => others.filter(b => langs.includes(langOf(b))).map(codeOf).join('\n\n');
  const wantsCss = !/<style[\s>]/i.test(html) || /<link[^>]+href=["'](?!https?:|\/\/)[^"']+\.css/i.test(html);
  const wantsJs = !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html) || /<script[^>]+src=["'](?!https?:|\/\/)[^"']+\.js/i.test(html);
  return { css: wantsCss ? pick(['css']) : '', js: wantsJs ? pick(['js', 'javascript']) : '' };
}

function runBlock(block) {
  const kind = block.dataset.run;
  const getDoc = () => {
    const code = codeOf(block);
    return buildDoc(kind, code, kind === 'html' ? siblingAssets(block, code) : {});
  };
  let label = kind === 'js' ? 'JavaScript' : kind.toUpperCase();
  if (kind === 'html') {
    const extra = siblingAssets(block, codeOf(block));
    const parts = [extra.css && 'CSS', extra.js && 'JS'].filter(Boolean);
    if (parts.length) label += ` + ${parts.join(' + ')} from this message`;
  }
  runIn(block, { kind, getDoc, label });
}

function toggleEdit(block, btn) {
  const pre = block.querySelector('.cb-code');
  const gutter = block.querySelector('.cb-gutter');
  const area = block.querySelector('.cb-edit-area');
  if (!area) {
    const ta = h('textarea', { class: 'cb-edit-area', spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
    ta.value = pre.textContent;
    ta.rows = Math.min(30, Math.max(6, ta.value.split('\n').length + 1));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && block.dataset.run) { e.preventDefault(); runBlock(block); }
    });
    pre.hidden = true;
    gutter.hidden = true;
    pre.after(ta);
    ta.focus();
    btn.textContent = 'Done';
    return;
  }
  const code = area.value;
  pre.querySelector('code').innerHTML = highlightCode(code, langOf(block));
  const n = code.split('\n').length;
  gutter.textContent = lineNumbers(n);
  block.querySelector('.cb-info').textContent = `${n} line${n === 1 ? '' : 's'} · edited`;
  area.remove();
  pre.hidden = false;
  gutter.hidden = false;
  btn.textContent = 'Edit';
}

const DEFAULT_NAMES = { html: 'index.html', htm: 'index.html', css: 'style.css', js: 'script.js', javascript: 'script.js', ts: 'main.ts', typescript: 'main.ts', py: 'main.py', python: 'main.py', json: 'data.json', svg: 'image.svg', md: 'README.md', markdown: 'README.md', sql: 'query.sql', sh: 'script.sh', bash: 'script.sh' };

async function saveBlock(block, btn) {
  const lang = langOf(block);
  const name = await promptDialog('Save to workspace as', DEFAULT_NAMES[lang] || `snippet.${lang || 'txt'}`);
  if (!name) return;
  try {
    const p = normPath(name);
    if (await state.fs.exists(p) && !(await confirmDialog(`${p} already exists. Overwrite it?`, 'Overwrite'))) return;
    await state.fs.write(p, codeOf(block));
    emit('fs-changed', p);
    flash(btn, 'Saved ✓');
    toast(`Saved ${p}`);
  } catch (e) { toast(e.message); }
}

export function initChat() {
  $('#chat').addEventListener('click', e => {
    const btn = e.target.closest('.cb-act button');
    if (!btn) return;
    const block = btn.closest('.codeblock');
    if (btn.classList.contains('cb-copy')) { navigator.clipboard?.writeText(codeOf(block)); flash(btn, 'Copied'); }
    else if (btn.classList.contains('cb-run')) runBlock(block);
    else if (btn.classList.contains('cb-edit')) toggleEdit(block, btn);
    else if (btn.classList.contains('cb-save')) saveBlock(block, btn);
  });
}
