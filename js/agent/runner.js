// The agent loop.
//
// Each step: build the system prompt → fit the context (prune, compact) → stream the model →
// recover text-written tool calls → run tools (read-only ones in parallel, edits sequentially,
// with approvals) → feed results back. Stops when the model answers without tools, with
// safeguards: loop detection, empty-reply nudge, auto-continue on unfinished todos, step limit.
import { state, emit, modelCaps, subagents } from '../core/state.js';
import { chatStream, HttpError } from '../core/ollama.js';
import { TOOLS, toolSchemas } from './tools.js';
import { extractToolCalls } from './parse.js';
import { prepareMessages, estimateTokens, compactThread } from './context.js';
import { parseArgs, clip } from '../util/misc.js';

/** Per-run tracker, shared with subagents. */
export function createRun() {
  return { started: Date.now(), steps: 0, toolCalls: 0, toolErrors: 0, changes: new Map(), read: new Set(), byModel: {} };
}

const resolveModel = agent => (agent.model && state.models.some(m => m.name === agent.model) ? agent.model : state.model);
const agentTools = (agent, depth) => (agent.tools || []).filter(n => TOOLS[n] && !(n === 'task' && (depth > 0 || !subagents().length)));
const autoApproved = perm => state.settings.perm === 'auto' || (state.settings.perm === 'edits' && perm === 'edit');

let fileCache = { t: 0, list: [] };
async function workspaceFiles() {
  if (Date.now() - fileCache.t > 2000) {
    try { fileCache = { t: Date.now(), list: await state.fs.list() }; } catch { fileCache = { t: Date.now(), list: [] }; }
  }
  return fileCache.list;
}
export const invalidateFileCache = () => { fileCache.t = 0; };

async function systemPrompt(agent, thread, names) {
  const files = await workspaceFiles();
  let rules = '';
  if (files.includes('AGENTS.md')) { try { rules = clip(await state.fs.read('AGENTS.md'), 6000); } catch { /* ignore */ } }
  const parts = [
    agent.prompt.trim(),
    '# Environment\n' +
      `- Workspace: ${state.fs.label}\n- Date: ${new Date().toDateString()}\n- Paths are relative to the workspace root and use "/".\n` +
      (names.length ? `- Tools: ${names.join(', ')}` : '- No tools are available right now. Answer directly; if files would need changes, show the code in your reply.'),
    `# Workspace files (${files.length})\n` + (files.length ? files.slice(0, 200).join('\n') + (files.length > 200 ? `\n… ${files.length - 200} more (use find_files)` : '') : '(empty)'),
  ];
  if (rules) parts.push('# Project instructions (AGENTS.md)\n' + rules);
  if (thread.summary) parts.push('# Summary of the earlier conversation (older messages were compacted)\n' + thread.summary);
  return parts.join('\n\n');
}

function nudge(thread, view, text, label) {
  thread.messages.push({ role: 'user', content: text, _auto: true });
  view.note('↻ ' + label, 'auto');
}

/**
 * Run an agent on a thread ({ messages, summary, summaryUpto }).
 * hooks: { persist(), getTodos(), setTodos(list), confirm(card, def) → bool, askUser(q, options, card) → string }
 * Returns { text, finished }.
 */
export async function runAgent({ agent, thread, view, signal, run, hooks = {}, depth = 0 }) {
  const S = state.settings;
  const model = resolveModel(agent);
  if (!model) throw new Error('No model selected');
  const caps = modelCaps(model);
  let names = caps.length && !caps.includes('tools') ? [] : agentTools(agent, depth);
  let think = caps.includes('thinking') && S.think !== 'auto' ? (S.think === 'on' ? true : S.think === 'off' ? false : S.think) : undefined;
  const budget = Math.max(2048, Math.floor(S.num_ctx * 0.75) - 512);
  const canWrite = names.some(n => TOOLS[n].perm === 'edit');
  const label = agent.name + (depth ? ' · subagent' : '');
  const stats = (run.byModel[model] ||= { requests: 0, evalTokens: 0, evalNs: 0, promptTokens: 0, toolCalls: 0, toolErrors: 0 });
  const loop = { history: [], strikes: 0, stop: false };
  const nudges = { empty: 0, todos: 0 };

  for (let step = 0; step < S.maxSteps; step++) {
    run.steps++;

    // 1) Fit the context window
    let system = await systemPrompt(agent, thread, names);
    let { msgs, tokens } = prepareMessages(thread, budget - estimateTokens(system));
    if (S.autoCompact && tokens + estimateTokens(system) > budget) {
      const note = view.note('Compacting context…', 'auto');
      try {
        const n = await compactThread(thread, { model, budget: budget - estimateTokens(system), signal, num_ctx: S.num_ctx, think: think === undefined ? undefined : false });
        note.textContent = n ? `↻ Context compacted: ${n} older messages summarized` : 'Context is large and could not be compacted further';
        if (n) {
          await hooks.persist?.();
          system = await systemPrompt(agent, thread, names);
          ({ msgs, tokens } = prepareMessages(thread, budget - estimateTokens(system)));
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        note.textContent = 'Compaction failed: ' + e.message;
      }
    }

    // 2) Ask the model (streaming)
    const block = view.block(label);
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...msgs],
      options: { temperature: agent.temperature ?? S.temperature, num_ctx: S.num_ctx },
    };
    if (names.length) body.tools = toolSchemas(names, subagents());
    if (think !== undefined) body.think = think;

    let res;
    try {
      res = await chatStream(body, {
        signal,
        onChunk: (_, acc) => { if (acc.thinking) block.thinking(acc.thinking); block.text(acc.content); },
      });
    } catch (e) {
      block.finish();
      if (e instanceof HttpError && body.tools && /does not support tools|tools? (are|is) not supported/i.test(e.detail)) {
        names = [];
        view.note('This model does not support tool calling: continuing in chat-only mode.', 'warn');
        run.steps--; step--; continue;
      }
      if (e instanceof HttpError && body.think !== undefined && /think/i.test(e.detail)) {
        think = undefined; run.steps--; step--; continue;
      }
      throw e;
    }

    stats.requests++;
    if (res.stats) {
      stats.evalTokens += res.stats.eval_count || 0;
      stats.evalNs += res.stats.eval_duration || 0;
      stats.promptTokens += res.stats.prompt_eval_count || 0;
      if (!depth) emit('llm-stats', {
        prompt: res.stats.prompt_eval_count || 0,
        output: res.stats.eval_count || 0,
        tps: res.stats.eval_duration ? res.stats.eval_count / (res.stats.eval_duration / 1e9) : 0,
      });
    }

    // 3) Tool calls: native, or recovered from text
    let calls = (res.tool_calls || []).filter(c => c?.function?.name);
    let content = res.content;
    if (!calls.length && names.length) {
      const parsed = extractToolCalls(content, names);
      if (parsed) { calls = parsed.calls; content = parsed.rest; block.badge('tool call recovered from text'); }
    }
    block.text(content, true);

    const msg = { role: 'assistant', content, _agent: agent.name };
    if (res.thinking) msg.thinking = res.thinking;
    if (calls.length) msg.tool_calls = calls.map(c => ({ function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } }));
    thread.messages.push(msg);

    // 4) No tools → final answer (unless a nudge is warranted)
    if (!calls.length) {
      block.finish();
      await hooks.persist?.();
      if (!content.trim() && nudges.empty < 1) {
        nudges.empty++;
        nudge(thread, view, 'Your previous reply was empty. Continue the task: call a tool, or give your final answer to the user.', 'Empty reply: asking the model to continue');
        continue;
      }
      const open = depth ? [] : (hooks.getTodos?.() || []).filter(t => t.status !== 'completed');
      if (S.autoContinue && canWrite && open.length && nudges.todos < 2) {
        nudges.todos++;
        nudge(thread, view,
          `You stopped, but these todo items are not completed:\n${open.map(t => `- [${t.status}] ${t.content}`).join('\n')}\n` +
          'Continue working on them now. If they are already done or no longer needed, update the list with todo_write, then give your final summary.',
          `Continuing: ${open.length} unfinished todo${open.length > 1 ? 's' : ''}`);
        continue;
      }
      return { text: content, finished: true };
    }

    // 5) Execute tools
    await executeCalls(calls, block, { agent, names, run, stats, loop, hooks, signal, depth, thread });
    block.finish();
    await hooks.persist?.();
    if (loop.stop) {
      view.note('Stopped: the agent kept repeating the same action.', 'warn');
      return { text: content, finished: false };
    }
  }
  view.note(`Reached the step limit (${S.maxSteps}). Send "continue" to keep going, or raise the limit in Settings.`, 'warn');
  return { text: '', finished: false };
}

async function executeCalls(calls, block, c) {
  const cards = calls.map(call => block.tool(call));
  const results = new Array(calls.length);
  const exec = async k => { results[k] = await executeOne(calls[k], cards[k], c); };
  const isRO = k => !!TOOLS[calls[k].function.name]?.readOnly;
  try {
    let i = 0;
    while (i < calls.length) {
      if (isRO(i)) {
        let j = i;
        while (j < calls.length && isRO(j)) j++;
        await Promise.all(Array.from({ length: j - i }, (_, d) => exec(i + d)));
        i = j;
      } else { await exec(i); i++; }
    }
  } finally {
    // Every tool call gets a result, even when interrupted, so the conversation stays valid.
    calls.forEach((call, k) => {
      c.thread.messages.push({ role: 'tool', tool_name: call.function.name, content: results[k] ?? 'Interrupted by the user.' });
      if (results[k] == null) { cards[k].status('err'); cards[k].result('Interrupted'); }
    });
  }
}

async function executeOne(call, card, c) {
  const name = call.function.name;
  const args = parseArgs(call.function.arguments);
  const def = TOOLS[name];
  card.args(args);
  c.run.toolCalls++; c.stats.toolCalls++;
  const fail = text => { c.run.toolErrors++; c.stats.toolErrors++; card.status('err'); card.result(text); return text; };

  if (!def || !c.names.includes(name)) return fail(`Error: unknown tool "${name}". Available tools: ${c.names.join(', ') || 'none'}.`);

  // Loop guard: identical call repeated without any file change in between
  const sig = name + ':' + JSON.stringify(args);
  const repeats = c.loop.history.slice(-10).filter(s => s === sig).length;
  c.loop.history.push(sig);
  if (repeats >= 2 && name !== 'todo_write') {
    if (++c.loop.strikes >= 3) c.loop.stop = true;
    return fail(`Error: you already called ${name} with these exact arguments ${repeats} times and the result will not change. Try a different approach, or stop and report to the user.`);
  }

  if (def.perm && !autoApproved(def.perm)) {
    card.status('pending');
    const ok = c.hooks.confirm ? await c.hooks.confirm(card, def) : true;
    if (c.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!ok) return fail('Denied by the user. Do not retry this exact action; choose another approach or ask the user what they want.');
  }

  card.status('running');
  if (name === 'task') card.open();
  try {
    let out = String((await def.run(args, toolContext(c, card))) ?? '');
    if (out.length > 30000) out = clip(out, 30000);
    if (def.perm === 'edit') c.loop.history = [];
    card.status('ok');
    card.result(out);
    return out;
  } catch (e) {
    if (e.name === 'AbortError' || c.signal.aborted) throw e;
    return fail('Error: ' + e.message);
  }
}

function toolContext(c, card) {
  return {
    fs: state.fs,
    signal: c.signal,
    tracker: c.run,
    changed: p => { invalidateFileCache(); emit('fs-changed', p); },
    setTodos: list => c.hooks.setTodos?.(list),
    askUser: (q, options) => (c.hooks.askUser ? c.hooks.askUser(q, options, card) : Promise.resolve('(no user available: decide yourself)')),
    spawn: (agentName, prompt) => spawnSubagent(agentName, prompt, card, c),
  };
}

async function spawnSubagent(agentName, prompt, card, c) {
  const ag = subagents().find(a => a.name === agentName || a.id === agentName);
  if (!ag) throw new Error(`Unknown subagent "${agentName}". Available: ${subagents().map(a => a.name).join(', ') || 'none'}.`);
  const thread = { messages: [{ role: 'user', content: String(prompt || '') }], summary: '', summaryUpto: 0 };
  const before = new Map(c.run.changes);
  const res = await runAgent({
    agent: ag, thread, view: card.subView(), signal: c.signal, run: c.run, depth: c.depth + 1,
    hooks: { confirm: c.hooks.confirm, askUser: c.hooks.askUser },
  });
  const changed = [...c.run.changes].filter(([p, k]) => before.get(p) !== k).map(([p, k]) => `${p} (${k})`);
  return (res.text || '(the subagent finished without a report)') + (changed.length ? `\n\nFiles changed by the subagent: ${changed.join(', ')}` : '');
}
