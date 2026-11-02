// Running conversations: registry, live status bar (what the agent is doing right now,
// how long, last token, stall warnings), the "N running" indicator and its switcher list.
import { state, on, emit } from '../core/state.js';
import { $, h, popover } from '../util/dom.js';
import { fmt } from '../util/misc.js';
import { loadedModels } from '../core/ollama.js';

/** session id -> { session, run, controller, agentName, model, conn } */
export const runs = new Map();
export const isRunning = id => !!id && runs.has(id);
export const currentRun = () => (state.session ? runs.get(state.session.id) : null);

export function abortAll() { for (const r of runs.values()) r.controller.abort(); }

const PHASES = {
  starting: { icon: '◌', text: 'Starting' },
  waiting: { icon: '⏳', text: 'Waiting for the model' },
  thinking: { icon: '💭', text: 'Thinking' },
  writing: { icon: '✍', text: 'Writing the answer' },
  calling: { icon: '🛠', text: 'Writing a tool call' },
  tool: { icon: '⚙', text: 'Running tool' },
  approval: { icon: '✋', text: 'Waiting for YOUR approval' },
  question: { icon: '❓', text: 'Waiting for YOUR answer' },
  compacting: { icon: '🗜', text: 'Compacting context' },
  retrying: { icon: '↻', text: 'Retrying' },
};
const MODEL_PHASES = new Set(['waiting', 'thinking', 'writing', 'calling']);

/** Human-readable status + health for a run. */
export function describe(rec) {
  const st = rec.run.status, now = Date.now();
  const p = PHASES[st.phase] || { icon: '•', text: st.phase };
  const inPhase = now - st.since;
  const silent = now - st.lastActivity;
  const S = state.settings;
  let health = 'ok', hint = '';
  if (MODEL_PHASES.has(st.phase)) {
    if (st.phase === 'waiting') {
      const limit = (S.firstTokenTimeout || 600) * 1000;
      if (silent > 30000) { health = 'slow'; hint = st.nativeTools ? 'No output yet. The model is reading the prompt, loading, or writing a native tool call (sent only when complete).' : `No output yet. Large prompts and loading a model into memory can take a while; it gives up after ${fmt.dur(limit)}.`; }
      if (rec.ps) hint = rec.ps + (hint ? ' ' + hint : '');
    } else {
      const limit = (S.idleTimeout || 120) * 1000;
      if (silent > 15000) { health = silent > limit / 2 ? 'stalled' : 'slow'; hint = `No new tokens for ${fmt.dur(silent)} (retries automatically after ${fmt.dur(limit)}).`; }
      if (st.nativeTools && silent > 15000) { health = 'slow'; hint = `No new tokens for ${fmt.dur(silent)}. With native tool calling Ollama sends a tool call only when it is complete, so the model may be writing a file right now. Settings → Agent → Tool calls: "Streamed" shows live progress.`; }
    }
  } else if (st.phase === 'approval' || st.phase === 'question') health = 'you';
  else if (st.phase === 'tool' && inPhase > 30000) { health = 'slow'; hint = 'This tool is taking long (web requests time out after 30–45 s).'; }
  const streamed = st.firstTokenAt ? (now - st.firstTokenAt) / 1000 : 0;
  const tokens = Math.round(st.chars / 4);
  const speed = streamed > 1 && tokens ? tokens / streamed : 0;
  return {
    icon: p.icon, phase: p.text, detail: st.detail, inPhase, silent, health, hint, tokens, speed,
    elapsed: now - rec.run.started, step: st.step, maxSteps: st.maxSteps, agent: st.agent, model: st.model || rec.model, retries: st.retries,
  };
}

function summaryLine(d) {
  const parts = [`${d.icon} ${d.phase}${d.detail ? ': ' + d.detail : ''}`];
  parts.push(fmt.dur(d.inPhase));
  if (MODEL_PHASES.has(d.phaseKey) && d.tokens) parts.push(`~${fmt.num(d.tokens)} tokens${d.speed ? ` · ${d.speed.toFixed(1)} tok/s` : ''}`);
  return parts.join(' · ');
}

/* ---------- status bar above the composer ---------- */
function paintBar() {
  const bar = $('#runbar');
  const rec = currentRun();
  if (!rec) { bar.hidden = true; return; }
  const d = { ...describe(rec), phaseKey: rec.run.status.phase };
  bar.hidden = false;
  bar.className = 'runbar ' + d.health;
  const lastTok = MODEL_PHASES.has(d.phaseKey) && rec.run.status.firstTokenAt ? ` · last token ${fmt.dur(d.silent)} ago` : '';
  bar.replaceChildren(...[
    h('div', { class: 'rb-main' },
      h('span', { class: 'rb-dot' }),
      h('b', {}, summaryLine(d)),
      h('span', { class: 'dim' }, ` · step ${d.step || 1}/${d.maxSteps || '?'} · total ${fmt.dur(d.elapsed)}${lastTok}${d.retries ? ` · ${d.retries} retr${d.retries > 1 ? 'ies' : 'y'}` : ''}`)),
    d.hint ? h('div', { class: 'rb-hint' }, d.hint) : null,
    h('div', { class: 'rb-act' },
      (d.health === 'you') && rec.run.status.card ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => { rec.run.status.card.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 'Show') : null,
      MODEL_PHASES.has(d.phaseKey) && rec.run.retryStep ? h('button', { class: 'btn sm', type: 'button', title: 'Cancel this model request and send it again', onclick: () => rec.run.retryStep?.() }, '↻ Retry step') : null,
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => rec.controller.abort() }, '■ Stop')),
  ].filter(Boolean));
}

/* ---------- "N running" indicator + switcher ---------- */
function paintIndicator() {
  const el = $('#running');
  const n = runs.size;
  el.hidden = !n;
  if (!n) return;
  const attention = [...runs.values()].some(r => ['approval', 'question'].includes(r.run.status.phase));
  el.className = 'running-btn' + (attention ? ' attention' : '');
  el.replaceChildren(h('span', { class: 'rb-dot' }), `${n} running`);
}

export function openRunningList(anchor, onPick) {
  popover(anchor, (el, close) => {
    const list = h('div', { class: 'pop-list' });
    const paint = () => {
      list.replaceChildren(...[...runs.entries()].map(([id, rec]) => {
        const d = { ...describe(rec), phaseKey: rec.run.status.phase };
        return h('div', { class: 'pop-row run-row ' + d.health + (state.session?.id === id ? ' on' : ''), onclick: () => { close(); onPick(id); } },
          h('div', { class: 'pr-main' }, h('b', { class: 'pr-name' }, rec.session.title || 'Untitled'), h('span', { class: 'dim small' }, `${rec.agentName} · ${rec.model}`)),
          h('div', { class: 'small' }, summaryLine(d)),
          h('div', { class: 'pr-sub' }, h('span', { class: 'dim small' }, `running ${fmt.dur(d.elapsed)} · step ${d.step || 1}`),
            h('button', { class: 'btn sm danger', type: 'button', onclick: e => { e.stopPropagation(); rec.controller.abort(); } }, 'Stop')));
      }));
      if (!runs.size) list.append(h('div', { class: 'dim pad' }, 'Nothing is running.'));
    };
    paint();
    const t = setInterval(() => { if (!el.isConnected) return clearInterval(t); paint(); }, 1000);
    el.append(h('div', { class: 'pop-sec' }, 'Running conversations'), list);
  });
}

/* ---------- model memory probe while waiting for the first token ---------- */
async function probe(rec) {
  if (rec.probing || Date.now() - (rec.probedAt || 0) < 8000) return;
  rec.probing = true;
  try {
    const loaded = await loadedModels(rec.conn);
    const m = loaded[rec.run.status.model || rec.model];
    const others = [...runs.values()].filter(r => r !== rec && r.conn?.url === rec.conn?.url).length;
    rec.ps = (m ? `Model is loaded in memory (${(m.size_vram / 1e9).toFixed(1)} GB in VRAM${m.size_vram < m.size ? ', partly on CPU: slower' : ''}).` : 'Model is not in memory yet: Ollama is loading it.') +
      (others ? ` ${others} other conversation${others > 1 ? 's are' : ' is'} using this server; requests queue unless OLLAMA_NUM_PARALLEL > 1.` : '');
  } catch { rec.ps = 'Could not reach the server to check the model status.'; }
  rec.probedAt = Date.now();
  rec.probing = false;
}

function tick() {
  for (const rec of runs.values()) {
    const st = rec.run.status;
    if (st.phase === 'waiting' && Date.now() - st.since > 4000) probe(rec);
    else if (st.phase !== 'waiting') rec.ps = '';
  }
  paintBar();
  paintIndicator();
  emit('runs-tick');
}

export function initRuns() {
  setInterval(tick, 1000);
  on('run-status', () => { paintBar(); paintIndicator(); });
  on('session', tick);
}

export function registerRun(id, rec) { runs.set(id, rec); tick(); emit('runs'); }
export function unregisterRun(id) { runs.delete(id); tick(); emit('runs'); }
