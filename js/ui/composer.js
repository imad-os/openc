// Composer: input, image attachments, slash commands, and orchestrating an agent run.
import { state, emit, currentAgent, primaryAgents, modelCaps, saveSettings } from '../core/state.js';
import { $, h, toast } from '../util/dom.js';
import { firstLine } from '../util/misc.js';
import { notify, unlockAudio } from '../util/sound.js';
import { runAgent, createRun } from '../agent/runner.js';
import { getMainView } from './chat.js';
import { persistSession, draftSession, renderTodos, newSession, markDirty } from './sessions.js';
import { recordModelStats, showModels } from './models.js';
import { cycleAgent, setAgent } from './workspace.js';
import { openAgents, openSettings } from './modals.js';

const pending = []; // base64 images

export function initComposer() {
  const inp = $('#inp');
  const phone = matchMedia('(max-width: 700px)');
  const placeholder = () => { inp.placeholder = phone.matches ? 'Message the agent…' : 'Ask the agent to build something…  (Enter send · Shift+Enter newline · Tab switch agent · / commands)'; };
  placeholder();
  phone.addEventListener?.('change', placeholder);
  inp.addEventListener('input', autosize);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !phone.matches) { e.preventDefault(); send(); }
    else if (e.key === 'Tab' && !e.shiftKey && !inp.value.includes('\n')) { e.preventDefault(); cycleAgent(); }
  });
  inp.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  $('#b-send').addEventListener('click', send);
  $('#b-stop').addEventListener('click', () => state.abort?.abort());
  $('#b-att').addEventListener('click', () => $('#f-img').click());
  $('#f-img').addEventListener('change', e => { addImages([...e.target.files]); e.target.value = ''; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.busy && !document.querySelector('.modal,.popover')) state.abort?.abort(); });
}

function autosize() {
  const inp = $('#inp');
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 220) + 'px';
}

const toBase64 = f => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(f);
});

async function addImages(files) {
  if (!modelCaps().includes('vision')) return toast('The selected model has no vision capability');
  for (const f of files) if (f.type.startsWith('image/')) pending.push(await toBase64(f));
  paintAttachments();
}

function paintAttachments() {
  $('#atts').replaceChildren(...pending.map((b64, i) => h('div', {},
    h('img', { src: 'data:image/png;base64,' + b64, alt: '' }),
    h('button', { type: 'button', onclick: () => { pending.splice(i, 1); paintAttachments(); } }, '×'))));
}

function setBusy(on) {
  state.busy = on;
  $('#b-send').hidden = on;
  $('#b-stop').hidden = !on;
  emit('busy', on);
}

function command(text) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'new': case 'clear': return newSession();
    case 'model': case 'models': return showModels();
    case 'agents': return openAgents();
    case 'settings': return openSettings();
    case 'display': return openSettings('display');
    case 'agent': {
      const a = primaryAgents().find(x => x.name === arg);
      return a ? setAgent(a.id) : toast('Agents: ' + primaryAgents().map(x => x.name).join(', '));
    }
    default: toast('Commands: /new  /model  /agent <name>  /agents  /settings  /display');
  }
}

function summarize(run, stopped, finished) {
  let tokens = 0, ns = 0;
  for (const m of Object.values(run.byModel)) { tokens += m.evalTokens; ns += m.evalNs; }
  return {
    duration: Date.now() - run.started, steps: run.steps, toolCalls: run.toolCalls, toolErrors: run.toolErrors,
    tokens, tps: ns ? tokens / (ns / 1e9) : 0, files: [...run.changes.entries()], stopped, finished,
  };
}

export async function send() {
  const inp = $('#inp');
  const text = inp.value.trim();
  if (state.busy || (!text && !pending.length)) return;
  if (text.startsWith('/')) { inp.value = ''; autosize(); return command(text); }
  if (!state.model) return showModels();
  unlockAudio();

  const s = state.session || (state.session = draftSession());
  const view = getMainView();
  if (!s.messages.length) view.clear();
  const um = { role: 'user', content: text };
  if (pending.length) { um.images = pending.splice(0); paintAttachments(); }
  s.messages.push(um);
  view.user(um);
  if (s.title === 'New session') s.title = (text || 'Image').replace(/\s+/g, ' ').slice(0, 60);
  s.agent = state.agentId;
  $('#title').textContent = s.title;
  inp.value = '';
  autosize();

  const run = createRun();
  const controller = new AbortController();
  const signal = controller.signal;
  state.abort = controller;
  setBusy(true);
  persistSession(s);

  const hooks = {
    persist: () => persistSession(s),
    getTodos: () => s.todos || [],
    setTodos: list => { s.todos = list; renderTodos(); },
    confirm: async (card, def) => {
      notify('attention', 'Approval needed', `${card.name} is waiting for you`, state.settings);
      const answer = await card.confirm(def.perm, signal);
      if (answer === 'always') { state.settings.perm = def.perm === 'edit' ? 'edits' : 'auto'; saveSettings(); }
      return answer === 'allow' || answer === 'always';
    },
    askUser: (question, options, card) => {
      notify('attention', 'The agent has a question', question, state.settings);
      return card.ask(question, options, signal);
    },
  };

  let result = null, error = null, stopped = false;
  try {
    result = await runAgent({ agent: currentAgent(), thread: s, view, signal, run, hooks });
  } catch (e) {
    if (e.name === 'AbortError') stopped = true; else error = e;
  }

  const summary = summarize(run, stopped, !!result?.finished);
  if (error) view.error(error.message);
  else {
    if (stopped) view.note('Stopped by you', 'warn');
    const last = s.messages.map(m => m.role).lastIndexOf('assistant');
    if (last >= 0) { s.messages[last]._run = summary; markDirty(s, last); }
    view.footer(summary, stopped ? '' : result?.text);
  }
  for (const [model, st] of Object.entries(run.byModel)) recordModelStats(model, { runs: 1, ...st });
  await persistSession(s);
  setBusy(false);
  state.abort = null;
  emit('fs-changed');
  if (!stopped) {
    notify(error ? 'error' : 'done',
      error ? 'Agent failed' : 'Agent finished',
      error ? error.message : firstLine(result?.text) || s.title, state.settings);
  }
}
