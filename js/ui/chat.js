// Chat rendering: message blocks (streaming text + thinking), tool cards (approve / ask),
// notes, run summary footer, and re-rendering a stored conversation.
import { $, h, esc } from '../util/dom.js';
import { renderMarkdown } from '../util/markdown.js';
import { parseArgs, fmt, firstLine } from '../util/misc.js';
import { emit } from '../core/state.js';

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

function makeBlock(parent, label, down, scrollEl) {
  const el = h('div', { class: 'msg asst live' });
  const head = h('div', { class: 'who' }, label);
  const thinkBody = h('div', { class: 'think-body' });
  const summary = h('summary', {}, 'Thinking…');
  const think = h('details', { class: 'think', hidden: true }, summary, thinkBody);
  const text = h('div', { class: 'md' });
  const tools = h('div', { class: 'tools' });
  el.append(head, think, text, tools);
  parent.append(el);
  let raf = 0, value = '', collapsed = false;
  const started = Date.now();
  const paint = final => { raf = 0; text.innerHTML = renderMarkdown(value, { highlight: final }); down(); };
  return {
    el,
    thinking(t) {
      if (!t) return;
      think.hidden = false;
      thinkBody.textContent = t;
      if (!value && !collapsed) think.open = true;
      down();
    },
    text(t, final) {
      value = t || '';
      if (value && !collapsed) { collapsed = true; think.open = false; summary.textContent = `Thought for ${fmt.dur(Date.now() - started)}`; }
      if (final) { cancelAnimationFrame(raf); paint(true); }
      else if (!raf) raf = requestAnimationFrame(() => paint(false));
    },
    badge(t) { head.append(h('span', { class: 'badge' }, t)); },
    tool(call) { const c = makeToolCard(call, down, scrollEl); tools.append(c.el); down(); return c; },
    finish() {
      if (raf) { cancelAnimationFrame(raf); paint(true); }
      if (!collapsed && !think.hidden) { think.open = false; summary.textContent = 'Thinking'; }
      el.classList.remove('live');
      if (!value.trim() && think.hidden && !tools.children.length) el.remove();
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
    if (m.thinking) b.thinking(m.thinking);
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

export function initChat() {
  $('#chat').addEventListener('click', e => {
    const btn = e.target.closest('.cb-copy');
    if (!btn) return;
    navigator.clipboard?.writeText(btn.closest('.codeblock').querySelector('code').textContent);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
}
