// MAX mode: several agents / models work on one request for a better result.
//   best : N independent attempts (each in its own temporary workspace), a judge picks the best one,
//          and the winner's files are copied into the real workspace.
//   team : a planner splits the request, workers (round-robin over the chosen models) build the parts
//          in the shared workspace, a reviewer checks the whole and fixes problems.
// Every attempt / worker / reviewer is shown as a collapsible "task" card in the conversation and
// stored like a normal subagent call, so reloading or continuing the chat just works.
import { state, emit } from '../core/state.js';
import { VirtualFS } from '../core/fs.js';
import { chatOnce } from '../core/ollama.js';
import { clip, firstLine } from '../util/misc.js';
import { createRun, runAgent, setPhase } from './runner.js';

export const MAX_DEFAULTS = Object.freeze({
  on: false,
  strategy: 'best',   // best | team
  models: [],         // model names to use (round-robin); empty = the selected model
  n: 3,               // attempts (best) or max workers (team)
  judge: '',          // judge model (best); empty = first model
  planner: '',        // planner model (team)
  reviewer: '',       // reviewer model (team)
  parallel: 'servers', // 'off' one after another | 'servers' different servers at the same time (each server one at a time) | 'all' everything at once
});

export const maxConfig = () => ({ ...MAX_DEFAULTS, ...(state.settings.max || {}) });
export const clampN = n => Math.max(1, Math.min(8, Math.round(Number(n) || 1)));

/** Temporary in-memory workspace for one attempt. */
class MemoryFS extends VirtualFS {
  constructor() { super('oc2.max.tmp'); this.files = {}; this.label = 'Temporary MAX workspace'; }
  save() { /* memory only */ }
}

async function copyFs(from, to) {
  const list = (await from.list()).slice(0, 400);
  for (const p of list) {
    try {
      const c = await from.read(p);
      if (typeof c === 'string' && c.length < 400000 && !c.includes('\u0000')) await to.write(p, c);
    } catch { /* skip unreadable */ }
  }
}

function mergeStats(parent, child) {
  parent.steps += child.steps;
  parent.toolCalls += child.toolCalls;
  parent.toolErrors += child.toolErrors;
  for (const [m, st] of Object.entries(child.byModel)) {
    const p = (parent.byModel[m] ||= { requests: 0, evalTokens: 0, evalNs: 0, promptTokens: 0, toolCalls: 0, toolErrors: 0, fails: 0 });
    for (const k of Object.keys(p)) p[k] += st[k] || 0;
  }
  if (child.lastFail) parent.lastFail = { ...(parent.lastFail || {}), ...child.lastFail };
}

/* A model spec in cfg is "name" (the connected server) or "<serverId>::name" (any saved server).
   `servers(id)` resolves a saved server to { conn, models } (provided by the caller). */
const here = (run, model) => ({ model, conn: run.conn, models: run.models, tag: '' });
async function resolveSpec(str, run, servers) {
  const [id, name] = String(str).includes('::') ? String(str).split('::') : [null, String(str)];
  if (!id || id === run.conn?.id) return run.models.some(m => m.name === name) ? here(run, name) : null;
  const srv = await servers?.(id).catch(() => null);
  if (!srv || !srv.models?.some(m => m.name === name)) return null;
  return { model: name, conn: srv.conn, models: srv.models, tag: srv.label || srv.conn.label || srv.conn.url };
}
async function pickSpecs(cfg, run, servers) {
  const out = [];
  for (const m of cfg.models || []) { const sp = await resolveSpec(m, run, servers); if (sp) out.push(sp); }
  return out.length ? out : [here(run, run.model)];
}
async function specOr(str, specs, run, servers) {
  return (str && await resolveSpec(str, run, servers)) || specs[0] || here(run, run.model);
}
const disp = sp => sp.model + (sp.tag ? ` @${sp.tag}` : '');

/** Run one agent to completion inside its own tracker. */
async function runChild({ agent, spec, messages, fs, parent, signal, view, hooks = {}, perm, onRun }) {
  const model = spec.model;
  const run = createRun({ conn: spec.conn, model, fs, models: spec.models });
  if (perm) run.perm = perm;
  onRun?.(run);
  const todos = [];
  const thread = { messages, summary: '', summaryUpto: 0 };
  const res = await runAgent({
    agent: { ...agent, model }, thread, view, signal, run,
    hooks: { getTodos: () => todos, setTodos: l => { todos.splice(0, todos.length, ...(l || [])); }, ...hooks },
  });
  return { text: res.text || '', finished: res.finished !== false, run, fs, model: disp(spec) };
}

/** Keep the parent's status line alive while children work. */
function startTicker(parent, label, children, total, doneCount) {
  const t = setInterval(() => {
    const active = children().filter(c => c.run && c.alive);
    const wait = active.find(c => ['approval', 'question'].includes(c.run.status.phase));
    Object.assign(parent.status, { agent: 'MAX', step: Math.min(doneCount() + 1, total), maxSteps: total });
    if (wait) { setPhase(parent, wait.run.status.phase, `${label} · ${wait.name}: ${wait.run.status.detail}`, { card: wait.run.status.card }); return; }
    const parts = active.slice(0, 3).map(c => `${c.name} ${c.run.status.detail || c.run.status.phase}`);
    setPhase(parent, 'tool', `${label} · ${doneCount()}/${total} done${parts.length ? ' · ' + parts.join(' | ') : ''}`);
  }, 1500);
  return () => clearInterval(t);
}

const taskCall = (agent, prompt) => ({ function: { name: 'task', arguments: { agent, prompt: clip(prompt, 600) } } });

/** Push assistant(tool_calls) now, tool results later (also on abort) so the history stays valid. */
function openCalls(thread, view, label, calls, content = '') {
  const msg = { role: 'assistant', content, tool_calls: calls, _agent: label };
  thread.messages.push(msg);
  const block = view.block(label);
  if (content) block.text(content, true);
  const cards = calls.map(c => { const card = block.tool(c); card.status('pending'); return card; });
  block.finish();
  return cards;
}
function closeCalls(thread, calls, results) {
  calls.forEach((c, k) => thread.messages.push({ role: 'tool', tool_name: 'task', content: results[k] ?? 'Interrupted by the user.' }));
}

/** mode: 'off' | 'servers' (one queue per server, queues side by side) | 'all'. Legacy true/false still work. */
async function runAll(items, mode, fn) {
  const m = mode === true ? 'all' : mode === false ? 'off' : mode;
  if (m === 'all') return void await Promise.all(items.map(fn));
  if (m === 'off') { for (const it of items) await fn(it); return; }
  const queues = new Map();
  for (const it of items) { const k = it.spec.conn?.id || it.spec.conn?.url || ''; (queues.get(k) || queues.set(k, []).get(k)).push(it); }
  await Promise.all([...queues.values()].map(async q => { for (const it of q) await fn(it); }));
}

const jsonFrom = text => {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
};

async function askJson({ spec, system, user, signal }) {
  const msg = await chatOnce({
    model: spec.model, format: 'json',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    options: { temperature: 0, num_ctx: state.settings.num_ctx },
  }, { signal, conn: spec.conn });
  return { json: jsonFrom(msg.content), text: msg.content || '' };
}

/* ---------------------------------------------------------------- best of N */
async function evidence(a, budget) {
  const head = `Final report:\n${clip(a.text || '(none)', 1800)}\nStats: ${a.run.steps} steps, ${a.run.toolCalls} tool calls, ${a.run.toolErrors} failed; ${a.finished ? 'finished' : 'did NOT finish (ran out of steps)'}.`;
  const out = [head];
  let left = Math.max(800, budget - head.length);
  const changed = [...a.run.changes];
  for (let i = 0; i < changed.length; i++) {
    const [p, kind] = changed[i];
    let body = '(deleted)';
    try { if (await a.fs.exists(p)) body = await a.fs.read(p); } catch { body = '(unreadable)'; }
    const cap = Math.max(500, Math.floor(left / (changed.length - i)));
    const piece = `--- file ${p} (${kind}) ---\n${clip(body, cap)}`;
    out.push(piece);
    left -= piece.length;
  }
  if (!changed.length) out.push('(no files were changed)');
  return out.join('\n');
}

const heuristicWinner = done => [...done].sort((x, y) =>
  (y.finished - x.finished) || (x.run.toolErrors - y.run.toolErrors) || (y.run.changes.size - x.run.changes.size))[0].i;

async function judge({ cfg, specs, servers, task, done, n, run, signal }) {
  const spec = await specOr(cfg.judge, specs, run, servers), model = disp(spec);
  const budget = Math.floor((state.settings.num_ctx * 2.2) / done.length);
  const blocks = [];
  for (const a of done) blocks.push(`===== ATTEMPT ${a.i + 1} (model ${a.model}) =====\n${await evidence(a, budget)}`);
  const system = 'You are a strict, impartial judge. Several AI agents independently attempted the same task. Compare them and choose the best one. Prefer the attempt that fully satisfies the request, has complete working code (look for placeholders, missing parts, syntax errors, failed tool calls) and reports honestly. ' +
    'Reply with JSON only: {"scores":[{"attempt":1,"score":0-10,"notes":"short"}],"winner":<attempt number>,"reason":"one or two sentences"}';
  const user = `TASK:\n${clip(task, 4000)}\n\n${blocks.join('\n\n')}`;
  setPhase(run, 'tool', `MAX · judge (${model}) is comparing ${done.length} attempts`);
  try {
    const { json } = await askJson({ spec, system, user, signal });
    const w = Number(json?.winner) - 1;
    if (json && done.some(a => a.i === w)) return { winner: w, reason: String(json.reason || ''), scores: Array.isArray(json.scores) ? json.scores : [], model };
  } catch (e) { if (e.name === 'AbortError') throw e; }
  const w = heuristicWinner(done);
  return { winner: w, reason: 'The judge gave no usable answer, so the attempt that finished with the fewest failed tool calls was chosen.', scores: [], model };
}

async function bestOfN({ cfg, agent, thread, view, signal, run, hooks, servers }) {
  const models = await pickSpecs(cfg, run, servers);
  const n = clampN(cfg.n);
  const lastUser = thread.messages[thread.messages.length - 1];
  const task = String(lastUser?.content || '');
  const label = `MAX · best of ${n}`;
  const specs = Array.from({ length: n }, (_, i) => ({ i, spec: models[i % models.length] }));
  const calls = specs.map(sp => taskCall(`attempt ${sp.i + 1}/${n} · ${disp(sp.spec)}`, task));
  const cards = openCalls(thread, view, label, calls);
  const results = new Array(n).fill(null);
  const attempts = new Array(n).fill(null);
  const live = specs.map(sp => ({ name: `#${sp.i + 1}`, run: null, alive: false }));
  let finished = 0;
  const stop = startTicker(run, label, () => live, n, () => finished);
  const history = thread.messages.slice(0, -1).map(m => ({ ...m }));
  try {
    await runAll(specs, cfg.parallel, async sp => {
      const card = cards[sp.i];
      card.status('running');
      card.open();
      try {
        const fs = new MemoryFS();
        await copyFs(run.fs, fs);
        const messages = [...history, { ...lastUser }];
        const r = await runChild({ agent, spec: sp.spec, messages, fs, parent: run, signal, view: card.subView(), perm: 'auto', onRun: cr => { live[sp.i].run = cr; live[sp.i].alive = true; } });
        attempts[sp.i] = { ...r, i: sp.i };
        const files = [...r.run.changes].map(([p, k]) => `${p} (${k})`);
        results[sp.i] = clip(r.text || '(no report)', 3500) + (files.length ? `\n\nFiles: ${files.join(', ')}` : '');
        card.status('ok');
        card.result(results[sp.i]);
        mergeStats(run, r.run);
      } catch (e) {
        if (e.name === 'AbortError' || signal.aborted) throw e;
        attempts[sp.i] = { error: e.message, i: sp.i };
        results[sp.i] = 'Error: ' + e.message;
        card.status('err');
        card.result(results[sp.i]);
      } finally { live[sp.i].alive = false; finished++; }
    });
  } finally {
    stop();
    closeCalls(thread, calls, results);
    await hooks.persist?.();
  }

  const done = attempts.filter(a => a && !a.error);
  if (!done.length) throw new Error('All attempts failed: ' + results.map((r, i) => `#${i + 1} ${firstLine(r, 120)}`).join(' · '));
  const verdict = done.length === 1
    ? { winner: done[0].i, reason: 'Only one attempt finished.', scores: [], model: '' }
    : await judge({ cfg, specs: models, servers, task, done, n, run, signal });
  const win = attempts[verdict.winner];

  // apply the winner's changes to the real workspace
  for (const [p, kind] of win.run.changes) {
    try {
      if (await win.fs.exists(p)) await run.fs.write(p, await win.fs.read(p));
      else if (await run.fs.exists(p)) await run.fs.remove(p);
      run.changes.set(p, kind);
      emit('fs-changed', p);
    } catch (e) { console.warn('apply winner', p, e); }
  }

  const scoreLines = verdict.scores.length
    ? '\n\n' + verdict.scores.map(s => `- Attempt ${s.attempt}${models[(Number(s.attempt) - 1) % models.length] ? ` (${disp(models[(Number(s.attempt) - 1) % models.length])})` : ''}: **${s.score}/10** ${s.notes ? '— ' + s.notes : ''}`).join('\n')
    : '';
  const text = `**⚖ Winner: attempt ${verdict.winner + 1} of ${n}** (${win.model})${verdict.model ? ` · judged by ${verdict.model}` : ''}\n\n${verdict.reason}${scoreLines}\n\n---\n\n${win.text || '(the winning attempt gave no written report)'}`;
  return finalize(thread, view, label, text, run, hooks, win.finished);
}

/* --------------------------------------------------------------------- team */
async function planTasks({ cfg, models, servers, task, n, run, signal }) {
  const spec = await specOr(cfg.planner, models, run, servers), model = disp(spec);
  const files = (await run.fs.list()).slice(0, 80);
  setPhase(run, 'tool', `MAX · planner (${model}) is splitting the work`);
  const system = `You are the technical lead of a small team of AI coding agents sharing one workspace. Split the request into at most ${n} parts that different agents can build without editing the same files (use fewer parts, or just 1, for a small request). ` +
    'Reply with JSON only: {"summary":"the approach in 1-3 sentences","tasks":[{"title":"short title","instructions":"complete self-contained instructions: files to create, interfaces and names shared between parts"}]}';
  const user = `REQUEST:\n${clip(task, 5000)}\n\nExisting workspace files: ${files.length ? files.join(', ') : '(empty)'}`;
  try {
    const { json } = await askJson({ spec, system, user, signal });
    const tasks = (json?.tasks || []).filter(t => t?.instructions).slice(0, n).map((t, i) => ({ title: String(t.title || `Part ${i + 1}`).slice(0, 80), instructions: String(t.instructions) }));
    if (tasks.length) return { summary: String(json.summary || ''), tasks, model };
  } catch (e) { if (e.name === 'AbortError') throw e; }
  return { summary: 'The planner gave no usable plan, so one worker does the whole task.', tasks: [{ title: 'Whole task', instructions: task }], model };
}

async function team({ cfg, agent, thread, view, signal, run, hooks, servers }) {
  const models = await pickSpecs(cfg, run, servers);
  const n = clampN(cfg.n);
  const lastUser = thread.messages[thread.messages.length - 1];
  const task = String(lastUser?.content || '');
  const label = 'MAX · team';
  const plan = await planTasks({ cfg, models, servers, task, n, run, signal });
  const m = plan.tasks.length;
  const planText = `**📋 Plan** (planner: ${plan.model})\n\n${plan.summary}\n\n${plan.tasks.map((t, i) => `${i + 1}. **${t.title}**`).join('\n')}`;

  const specs = plan.tasks.map((t, i) => ({ i, t, spec: models[i % models.length] }));
  const calls = specs.map(sp => taskCall(`worker ${sp.i + 1}/${m} · ${disp(sp.spec)} · ${sp.t.title}`, sp.t.instructions));
  const cards = openCalls(thread, view, label, calls, planText);
  const results = new Array(m).fill(null);
  const reports = new Array(m).fill('');
  const live = specs.map(sp => ({ name: `worker ${sp.i + 1}`, run: null, alive: false }));
  let finished = 0;
  const stop = startTicker(run, label, () => live, m + 1, () => finished);
  const others = i => plan.tasks.map((t, k) => (k === i ? null : `- ${t.title}`)).filter(Boolean).join('\n') || '(none)';
  try {
    await runAll(specs, cfg.parallel, async sp => {
      const card = cards[sp.i];
      card.status('running');
      card.open();
      const prompt = `You are worker ${sp.i + 1} of ${m} in a team building this together in one shared workspace.\n\nOVERALL REQUEST:\n${task}\n\nTEAM PLAN: ${plan.summary}\n\nYOUR PART: ${sp.t.title}\n${sp.t.instructions}\n\nPARTS OF YOUR TEAMMATES (do NOT do these):\n${others(sp.i)}\n\nRules: read existing files before editing them; only create or change files that belong to your part; keep the names and interfaces from the plan; when done, reply with a short report (files created or changed, public interfaces).`;
      try {
        const r = await runChild({ agent, spec: sp.spec, messages: [{ role: 'user', content: prompt }], fs: run.fs, parent: run, signal, view: card.subView(), hooks: { confirm: hooks.confirm, askUser: hooks.askUser }, onRun: cr => { live[sp.i].run = cr; live[sp.i].alive = true; } });
        for (const [p, k] of r.run.changes) run.changes.set(p, k);
        mergeStats(run, r.run);
        reports[sp.i] = r.text;
        results[sp.i] = clip(r.text || '(no report)', 3500);
        card.status('ok');
        card.result(results[sp.i]);
      } catch (e) {
        if (e.name === 'AbortError' || signal.aborted) throw e;
        results[sp.i] = 'Error: ' + e.message;
        card.status('err');
        card.result(results[sp.i]);
      } finally { live[sp.i].alive = false; finished++; }
    });
  } finally {
    stop();
    closeCalls(thread, calls, results);
    await hooks.persist?.();
  }

  // reviewer / integrator
  const rSpec = await specOr(cfg.reviewer, models, run, servers);
  const rCall = taskCall(`reviewer · ${disp(rSpec)}`, 'Review the team result, test it and fix problems.');
  const [rCard] = openCalls(thread, view, label, [rCall]);
  rCard.status('running');
  rCard.open();
  const rLive = { name: 'reviewer', run: null, alive: true };
  const stop2 = startTicker(run, label, () => [rLive], m + 1, () => m);
  let report = '', rRes = null, rFinished = true;
  try {
    const prompt = `You are the reviewer and integrator of a team of agents. They just worked on this request:\n\n${task}\n\nPLAN: ${plan.summary}\n\nWORKER REPORTS:\n${reports.map((r, i) => `[${i + 1}] ${plan.tasks[i].title} (${disp(specs[i].spec)}):\n${clip(r || '(no report)', 1500)}`).join('\n\n')}\n\nInspect the workspace, check that the parts fit together and the whole request is satisfied (read the files; test logic with run_js when possible). Fix every problem you find directly. Finish with a final report for the user: what was built, the files, how to run or use it, and any limitations. Do not paste whole files.`;
    const r = await runChild({ agent, spec: rSpec, messages: [{ role: 'user', content: prompt }], fs: run.fs, parent: run, signal, view: rCard.subView(), hooks: { confirm: hooks.confirm, askUser: hooks.askUser }, onRun: cr => { rLive.run = cr; } });
    for (const [p, k] of r.run.changes) run.changes.set(p, k);
    mergeStats(run, r.run);
    report = r.text;
    rFinished = r.finished;
    rRes = 'Reviewed and finalized. The report follows below.';
    rCard.status('ok');
    rCard.result(rRes);
  } catch (e) {
    if (e.name === 'AbortError' || signal.aborted) throw e;
    rRes = 'Error: ' + e.message;
    report = `The reviewer failed (${e.message}). The workers' reports:\n\n` + reports.map((r, i) => `**${plan.tasks[i].title}:** ${firstLine(r, 400)}`).join('\n\n');
    rCard.status('err');
    rCard.result(rRes);
  } finally {
    rLive.alive = false;
    stop2();
    closeCalls(thread, [rCall], [rRes]);
    await hooks.persist?.();
  }
  return finalize(thread, view, label, report || '(the reviewer gave no report)', run, hooks, rFinished);
}

function finalize(thread, view, label, text, run, hooks, finished) {
  thread.messages.push({ role: 'assistant', content: text, _agent: label });
  const b = view.block(label);
  b.text(text, true);
  b.finish();
  return { text, finished };
}

/** Entry point used by composer.runTurn instead of runAgent. */
export async function runMax(args) {
  const cfg = { ...MAX_DEFAULTS, ...(args.cfg || {}) };
  return cfg.strategy === 'team' ? team({ ...args, cfg }) : bestOfN({ ...args, cfg });
}
