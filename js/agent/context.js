// Context-window management: token estimates, pruning old tool output, and compaction
// (summarizing older messages so long sessions keep working).
import { parseArgs, clip } from '../util/misc.js';
import { chatOnce } from '../core/ollama.js';

export const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(x) {
  if (typeof x === 'string') return Math.ceil(x.length / CHARS_PER_TOKEN);
  let n = 0;
  for (const m of x) {
    n += 4 + (m.content?.length || 0) / CHARS_PER_TOKEN;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length / CHARS_PER_TOKEN;
    if (m.images) n += 800 * m.images.length;
  }
  return Math.ceil(n);
}

/** Message as sent to Ollama (drops UI-only fields). */
export function toWire(m) {
  const o = { role: m.role, content: m.content ?? '' };
  if (m.images?.length) o.images = m.images;
  if (m.tool_calls?.length) o.tool_calls = m.tool_calls.map(c => ({ function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } }));
  if (m.tool_name) o.tool_name = m.tool_name;
  return o;
}

const BIG_ARG_KEYS = ['content', 'new_string', 'old_string', 'code', 'prompt'];

/**
 * Messages after the compaction point, with old bulky tool output/arguments trimmed
 * until they fit `budget` tokens. The stored conversation is never modified.
 */
export function prepareMessages(thread, budget) {
  const msgs = thread.messages.slice(thread.summaryUpto || 0).map(toWire);
  let tokens = estimateTokens(msgs);
  const KEEP_RECENT = 8;
  for (let i = 0; i < msgs.length - KEEP_RECENT && tokens > budget; i++) {
    const m = msgs[i];
    const before = estimateTokens([m]);
    if (m.role === 'tool' && m.content.length > 1000) {
      msgs[i] = { ...m, content: m.content.slice(0, 400) + `\n…[${m.content.length - 400} chars of old output removed to save context; run the tool again if needed]` };
    } else if (m.role === 'assistant' && m.tool_calls) {
      let changed = false;
      const calls = m.tool_calls.map(c => {
        const a = { ...c.function.arguments };
        for (const k of BIG_ARG_KEYS) if (typeof a[k] === 'string' && a[k].length > 1500) { a[k] = a[k].slice(0, 300) + `…[${a[k].length - 300} chars omitted]`; changed = true; }
        return { function: { name: c.function.name, arguments: a } };
      });
      if (!changed) continue;
      msgs[i] = { ...m, tool_calls: calls };
    } else continue;
    tokens += estimateTokens([msgs[i]]) - before;
  }
  if (msgs.length && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '(Earlier work is summarized in the system prompt.) Continue.' });
  return { msgs, tokens };
}

/** Index to cut at so the kept tail is ~35% of the budget; never cuts between a tool call and its result. */
function pickCut(thread, budget) {
  const ms = thread.messages, start = thread.summaryUpto || 0;
  let tail = 0;
  for (let i = ms.length - 1; i > start; i--) {
    tail += estimateTokens([ms[i]]);
    if (tail > budget * 0.35) {
      for (let j = i + 1; j < ms.length; j++) if (ms[j].role !== 'tool') return j > start + 1 ? j : -1;
      return -1;
    }
  }
  return -1;
}

function transcript(thread, upto) {
  const parts = [];
  if (thread.summary) parts.push('[summary of even earlier conversation]\n' + thread.summary);
  for (const m of thread.messages.slice(thread.summaryUpto || 0, upto)) {
    if (m.role === 'user') parts.push((m._auto ? '[system nudge]\n' : '[user]\n') + m.content);
    else if (m.role === 'assistant') {
      let s = '[assistant]\n' + (m.content || '');
      for (const c of m.tool_calls || []) s += `\n→ ${c.function.name}(${clip(JSON.stringify(parseArgs(c.function.arguments)), 300)})`;
      parts.push(s);
    } else if (m.role === 'tool') parts.push(`[${m.tool_name || 'tool'} result]\n` + clip(m.content, 600));
  }
  return parts.join('\n\n');
}

const COMPACT_PROMPT = `You compress a coding-agent conversation so the work can continue in a fresh context window.
Write a concise but complete summary in Markdown with these sections:
## Goal — what the user wants (keep key requirements verbatim)
## Done so far — decisions made; files created or changed and what they contain (structure, key functions)
## Current state — what works, known problems, last thing being worked on
## Next steps — what remains
Keep exact file paths, names and important values. No preamble.`;

/** Summarize older messages into thread.summary. Returns the number of messages compacted (0 = nothing done). */
export async function compactThread(thread, { model, budget, signal, num_ctx, think }) {
  const cut = pickCut(thread, budget);
  if (cut < 0) return 0;
  let text = transcript(thread, cut);
  const max = Math.floor(budget * CHARS_PER_TOKEN * 0.85);
  if (text.length > max) text = text.slice(0, Math.floor(max * 0.3)) + '\n\n…[middle omitted]…\n\n' + text.slice(-Math.floor(max * 0.7));
  const body = {
    model,
    messages: [{ role: 'system', content: COMPACT_PROMPT }, { role: 'user', content: 'Conversation to summarize:\n\n' + text }],
    options: { temperature: 0.1, num_ctx },
  };
  if (think !== undefined) body.think = think;
  const msg = await chatOnce(body, { signal });
  const summary = String(msg.content || '').trim();
  if (!summary) return 0;
  const n = cut - (thread.summaryUpto || 0);
  thread.summary = summary.slice(0, 150000);
  thread.summaryUpto = cut;
  return n;
}
