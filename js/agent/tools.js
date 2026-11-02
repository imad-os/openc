// Agent tools: definitions (JSON schema for the model) + implementations.
// ctx passed to run(): { fs, signal, tracker:{read:Set, changes:Map}, changed(path), setTodos, askUser, spawn }
import { normPath, globToRegex } from '../core/fs.js';
import { clip } from '../util/misc.js';
import { webFetch, webSearch } from './web.js';

const S = description => ({ type: 'string', description });
const B = description => ({ type: 'boolean', description });
const I = description => ({ type: 'integer', description });

const isBinary = t => t.includes('\u0000');

async function filesUnder(fs, dir) {
  const p = normPath(dir || '');
  const all = await fs.list();
  return p ? all.filter(f => f === p || f.startsWith(p + '/')) : all;
}

function markChanged(ctx, p, kind) {
  const prev = ctx.tracker.changes.get(p);
  ctx.tracker.changes.set(p, prev === 'created' && kind === 'modified' ? 'created' : kind);
  ctx.changed(p);
}

/** Whitespace/indentation-insensitive line-block replacement. */
function fuzzyReplace(text, oldS, newS) {
  const lines = text.split('\n');
  const olds = oldS.replace(/\n$/, '').split('\n');
  const target = olds.map(l => l.trim());
  if (!target.join('')) return { count: 0 };
  const hits = [];
  for (let i = 0; i + olds.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < olds.length; j++) if (lines[i + j].trim() !== target[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { count: hits.length };
  const i = hits[0];
  const fileIndent = lines[i].match(/^\s*/)[0], oldIndent = olds[0].match(/^\s*/)[0];
  let repl = newS === '' ? [] : newS.replace(/\n$/, '').split('\n');
  if (fileIndent !== oldIndent) repl = repl.map(l => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l));
  lines.splice(i, olds.length, ...repl);
  return { text: lines.join('\n'), count: 1 };
}

async function snapshotFiles(fs) {
  const files = {};
  let total = 0;
  for (const p of await fs.list()) {
    if (total > 3e6) break;
    try {
      const t = await fs.read(p);
      if (t.length < 400000 && !isBinary(t)) { files[p] = t; total += t.length; }
    } catch { /* skip */ }
  }
  return files;
}

const WORKER_SRC = `
const out = [];
const fmt = v => { if (typeof v === 'string') return v; try { return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? String(x) : x, 2); } catch { return String(v); } };
const log = (...a) => out.push(a.map(fmt).join(' '));
console.log = console.info = console.debug = log;
console.warn = (...a) => log('[warn]', ...a);
console.error = (...a) => log('[error]', ...a);
console.table = v => log(v);
self.onmessage = async (e) => {
  const { code, files } = e.data;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction('files', code)(files);
    postMessage({ out: out.join('\\n'), result: result === undefined ? undefined : fmt(result) });
  } catch (err) {
    postMessage({ out: out.join('\\n'), error: String((err && err.stack) || err) });
  }
};`;

function runInWorker(code, files, signal, timeout = 15000) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let timer;
    const finish = v => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(v); };
    timer = setTimeout(() => finish(`Error: timed out after ${timeout / 1000}s (infinite loop or never-resolving promise?)`), timeout);
    signal?.addEventListener('abort', () => finish('Interrupted.'), { once: true });
    worker.onmessage = e => {
      const { out, result, error } = e.data;
      finish([error && 'Error: ' + error, out && 'Output:\n' + out, result !== undefined && 'Return value: ' + result]
        .filter(Boolean).join('\n') || '(no output: use console.log or return a value)');
    };
    worker.onerror = e => { e.preventDefault(); finish('Error: ' + (e.message || 'worker failed')); };
    worker.postMessage({ code: String(code ?? ''), files });
  });
}

/**
 * readOnly: may run in parallel with other readOnly calls.
 * perm: 'edit' | 'exec' | undefined — needs approval unless auto-approved in settings.
 */
export const TOOLS = {
  list_files: {
    readOnly: true,
    description: 'List all files in the workspace recursively, optionally only under one directory.',
    parameters: { path: S('Directory relative to the workspace root. Omit to list everything.') },
    async run({ path }, ctx) {
      const files = await filesUnder(ctx.fs, path);
      if (!files.length) return path ? `No files under "${path}".` : 'The workspace is empty.';
      return clip(files.join('\n'), 20000) + `\n(${files.length} files)`;
    },
  },

  find_files: {
    readOnly: true,
    description: 'Find files whose path matches a glob pattern, e.g. "**/*.js", "src/**/*.css", "*.html".',
    parameters: { pattern: S('Glob pattern: * matches within one folder, ** across folders, {a,b} alternatives.') },
    required: ['pattern'],
    async run({ pattern }, ctx) {
      const re = globToRegex(pattern);
      const nameOnly = !String(pattern).includes('/');
      const hits = (await ctx.fs.list()).filter(f => re.test(f) || (nameOnly && re.test(f.split('/').pop())));
      return hits.length ? clip(hits.join('\n'), 20000) + `\n(${hits.length} matches)` : `No files match "${pattern}".`;
    },
  },

  read_file: {
    readOnly: true,
    description: 'Read a text file. Returns lines prefixed with line numbers ("  12| text"); the prefix is not part of the file. For large files read a section with offset/limit.',
    parameters: { path: S('File path'), offset: I('First line to read, 1-based (default 1)'), limit: I('Maximum number of lines (default 2000)') },
    required: ['path'],
    async run({ path, offset = 1, limit = 2000 }, ctx) {
      const p = normPath(path);
      const text = await ctx.fs.read(p);
      ctx.tracker.read.add(p);
      if (isBinary(text)) return `${p} looks like a binary file and cannot be shown.`;
      if (!text) return `${p} is empty.`;
      const lines = text.split('\n');
      const start = Math.max(1, parseInt(offset, 10) || 1) - 1;
      const n = Math.max(1, parseInt(limit, 10) || 2000);
      const slice = lines.slice(start, start + n);
      let out = slice.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
      if (out.length > 80000) out = out.slice(0, 80000) + '\n…[output truncated; read a smaller range]';
      const rest = lines.length - start - slice.length;
      if (rest > 0) out += `\n… ${rest} more lines (continue with offset=${start + slice.length + 1})`;
      return out;
    },
  },

  grep: {
    readOnly: true,
    description: 'Search file contents with a JavaScript regular expression. Returns "path:line: text" for each matching line.',
    parameters: {
      pattern: S('Regular expression'),
      path: S('Optional directory or file to search in'),
      include: S('Optional glob filter for file names, e.g. "*.js"'),
      ignore_case: B('Case-insensitive search (default true)'),
    },
    required: ['pattern'],
    async run({ pattern, path, include, ignore_case = true }, ctx) {
      let re;
      try { re = new RegExp(pattern, ignore_case === false ? '' : 'i'); } catch (e) { throw new Error('Invalid regular expression: ' + e.message); }
      const inc = include ? globToRegex(include) : null;
      const files = (await filesUnder(ctx.fs, path)).filter(f => !inc || inc.test(f) || inc.test(f.split('/').pop()));
      const out = [];
      let total = 0;
      for (const f of files) {
        let t;
        try { t = await ctx.fs.read(f); } catch { continue; }
        if (t.length > 1e6 || isBinary(t)) continue;
        const lines = t.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) { total++; if (out.length < 150) out.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 240)}`); }
        }
      }
      if (!total) return 'No matches.';
      return out.join('\n') + (total > out.length ? `\n… ${total - out.length} more matches (narrow the search)` : '');
    },
  },

  write_file: {
    perm: 'edit',
    description: 'Create a new file, or completely replace an existing one (read it first). Parent folders are created automatically. Always provide the complete file content.',
    parameters: { path: S('File path'), content: S('The complete file content') },
    required: ['path', 'content'],
    async run({ path, content }, ctx) {
      const p = normPath(path);
      if (!p) throw new Error('path is required');
      const exists = await ctx.fs.exists(p);
      if (exists && !ctx.tracker.read.has(p)) throw new Error(`${p} already exists. Read it with read_file first, then overwrite it, or use edit_file for a targeted change.`);
      const text = String(content ?? '');
      await ctx.fs.write(p, text);
      ctx.tracker.read.add(p);
      markChanged(ctx, p, exists ? 'modified' : 'created');
      return `${exists ? 'Overwrote' : 'Created'} ${p} (${text.split('\n').length} lines).`;
    },
  },

  edit_file: {
    perm: 'edit',
    description: 'Replace an exact piece of text in a file. old_string must match the file exactly (without read_file line-number prefixes) and be unique unless replace_all is true. Include a few surrounding lines to make it unique. Read the file first.',
    parameters: {
      path: S('File path'),
      old_string: S('Exact text to replace'),
      new_string: S('Replacement text'),
      replace_all: B('Replace every occurrence (default false)'),
    },
    required: ['path', 'old_string', 'new_string'],
    async run({ path, old_string, new_string = '', replace_all = false }, ctx) {
      const p = normPath(path);
      if (!(await ctx.fs.exists(p))) throw new Error(`${p} does not exist. Use write_file to create it.`);
      if (!ctx.tracker.read.has(p)) throw new Error(`Read ${p} with read_file before editing it.`);
      if (old_string == null || old_string === '') throw new Error('old_string must not be empty (use write_file to replace a whole file).');
      if (old_string === new_string) throw new Error('old_string and new_string are identical; nothing to change.');
      const raw = await ctx.fs.read(p);
      const crlf = raw.includes('\r\n');
      const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
      let oldS = String(old_string).replace(/\r\n/g, '\n');
      const newS = String(new_string ?? '').replace(/\r\n/g, '\n');
      let count = text.split(oldS).length - 1;
      let note = '';
      if (!count) {
        const stripped = oldS.replace(/^ *\d+\| ?/gm, '');
        if (stripped !== oldS && text.includes(stripped)) { oldS = stripped; count = text.split(oldS).length - 1; note = ' (removed line-number prefixes from old_string)'; }
      }
      let out;
      if (count === 1 || (count > 1 && replace_all)) {
        out = replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      } else if (count > 1) {
        throw new Error(`old_string matches ${count} places in ${p}. Include more surrounding lines to make it unique, or set replace_all=true.`);
      } else {
        const f = fuzzyReplace(text, oldS, newS);
        if (f.text != null) { out = f.text; count = 1; note = ' (matched ignoring whitespace/indentation differences)'; }
        else if (f.count > 1) throw new Error(`old_string matches ${f.count} places (ignoring whitespace). Include more surrounding lines.`);
        else throw new Error(`old_string was not found in ${p}. Read the file again and copy the exact current text, including whitespace.`);
      }
      await ctx.fs.write(p, crlf ? out.replace(/\n/g, '\r\n') : out);
      markChanged(ctx, p, 'modified');
      const n = replace_all ? count : 1;
      return `Edited ${p}: ${n} replacement${n > 1 ? 's' : ''}${note}.`;
    },
  },

  move_file: {
    perm: 'edit',
    description: 'Move or rename a file.',
    parameters: { from: S('Current path'), to: S('New path') },
    required: ['from', 'to'],
    async run({ from, to }, ctx) {
      const a = normPath(from), b = normPath(to);
      if (await ctx.fs.exists(b)) throw new Error(`${b} already exists.`);
      await ctx.fs.move(a, b);
      ctx.tracker.read.add(b);
      markChanged(ctx, a, 'deleted');
      markChanged(ctx, b, 'created');
      return `Moved ${a} → ${b}.`;
    },
  },

  delete_file: {
    perm: 'edit',
    description: 'Delete a file.',
    parameters: { path: S('File path') },
    required: ['path'],
    async run({ path }, ctx) {
      const p = normPath(path);
      await ctx.fs.remove(p);
      markChanged(ctx, p, 'deleted');
      return `Deleted ${p}.`;
    },
  },

  run_js: {
    perm: 'exec',
    description: 'Run JavaScript in an isolated web worker (no DOM, no network guarantees, 15 s limit). Top-level await works. Workspace text files are available read-only as `files` (an object: path → content). Output from console.log and the returned value are reported. Use it to test logic.',
    parameters: { code: S('JavaScript code to run') },
    required: ['code'],
    async run({ code }, ctx) {
      return runInWorker(code, await snapshotFiles(ctx.fs), ctx.signal);
    },
  },

  web_search: {
    readOnly: true,
    web: true,
    description: 'Search the internet. Returns titles, URLs and snippets. Use it to find official documentation, SDK references, API changes and examples; then read pages with web_fetch.',
    parameters: { query: S('Search query, e.g. "stripe node sdk create payment intent docs"'), max_results: I('Number of results, 1-10 (default 8)') },
    required: ['query'],
    async run({ query, max_results = 8 }, ctx) {
      const { provider, results } = await webSearch(String(query || ''), Math.min(10, Math.max(1, parseInt(max_results, 10) || 8)), ctx.signal);
      return `Results from ${provider} for "${query}":\n\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + clip(r.snippet.replace(/\s+/g, ' '), 300) : ''}`).join('\n');
    },
  },

  web_fetch: {
    readOnly: true,
    web: true,
    description: 'Read a web page (documentation, README, API reference, raw file) as text/Markdown. Long pages are returned in chunks: call again with the given offset to continue.',
    parameters: { url: S('Full URL (https://...)'), offset: I('Character offset to continue reading a long page (default 0)'), max_chars: I('Maximum characters to return (default 20000)') },
    required: ['url'],
    async run({ url, offset = 0, max_chars = 20000 }, ctx) {
      const page = await webFetch(String(url || '').trim(), ctx.signal);
      const start = Math.max(0, parseInt(offset, 10) || 0);
      const n = Math.min(40000, Math.max(1000, parseInt(max_chars, 10) || 20000));
      const chunk = page.content.slice(start, start + n);
      const rest = page.content.length - start - chunk.length;
      return `# ${page.title}\nURL: ${url} (via ${page.via}, ${page.content.length} chars)\n\n${chunk}` +
        (rest > 0 ? `\n\n…[${rest} more chars: call web_fetch again with offset=${start + chunk.length}]` : '');
    },
  },

  todo_write: {
    description: 'Create or update the task list for the current work. Always send the complete list. Status is one of pending, in_progress, completed. Keep exactly one item in_progress while working.',
    parameters: {
      todos: {
        type: 'array',
        description: 'The full todo list',
        items: {
          type: 'object',
          properties: { content: S('Task description'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
    async run({ todos }, ctx) {
      if (typeof todos === 'string') { try { todos = JSON.parse(todos); } catch { /* handled below */ } }
      if (!Array.isArray(todos)) throw new Error('todos must be an array of { content, status }.');
      const list = todos.slice(0, 100).map(t => ({
        content: String(typeof t === 'string' ? t : t?.content ?? '').slice(0, 500),
        status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
      })).filter(t => t.content);
      ctx.setTodos(list);
      const done = list.filter(t => t.status === 'completed').length;
      return `Todo list updated: ${done}/${list.length} completed.`;
    },
  },

  ask_user: {
    description: 'Ask the user a question and wait for the answer. Only use this when you truly need a decision or information you cannot reasonably assume.',
    parameters: {
      question: S('The question to ask'),
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers the user can click' },
    },
    required: ['question'],
    async run({ question, options }, ctx) {
      const answer = await ctx.askUser(String(question || ''), Array.isArray(options) ? options.slice(0, 8).map(String) : []);
      return `The user answered: ${answer}`;
    },
  },

  task: {
    description: '(built dynamically from the available subagents)',
    parameters: {},
    required: ['agent', 'prompt'],
    run({ agent, prompt }, ctx) { return ctx.spawn(agent, prompt); },
  },
};

/** JSON schemas for the Ollama `tools` field. */
export function toolSchemas(names, subs = []) {
  return names.map(name => {
    if (name === 'task') {
      return {
        type: 'function',
        function: {
          name: 'task',
          description: 'Delegate a self-contained job to a subagent that works independently with its own tools and returns a report. Subagents: ' +
            subs.map(a => `"${a.name}" (${a.desc || 'no description'})`).join('; '),
          parameters: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: subs.map(a => a.name), description: 'Subagent name' },
              prompt: S('Complete, self-contained instructions. The subagent cannot see this conversation.'),
            },
            required: ['agent', 'prompt'],
          },
        },
      };
    }
    const t = TOOLS[name];
    return { type: 'function', function: { name, description: t.description, parameters: { type: 'object', properties: t.parameters, required: t.required || [] } } };
  });
}

/**
 * "Streamed" tool calling: tools are described in the system prompt and the model writes
 * <tool_call>{json}</tool_call> as normal text. Everything streams (you can watch a file being
 * written), works with models that lack native tool support, and avoids Ollama buffering a
 * whole tool call silently until it is complete.
 */
export function toolProtocolPrompt(names, subs = []) {
  const docs = toolSchemas(names, subs).map(({ function: f }) => {
    const props = f.parameters.properties || {};
    const req = new Set(f.parameters.required || []);
    const args = Object.entries(props).map(([k, p]) => {
      const type = p.enum ? p.enum.map(v => JSON.stringify(v)).join(' | ') : p.type === 'array' ? 'array' : p.type;
      return `  - ${k}${req.has(k) ? '' : ' (optional)'}: ${type}${p.description ? ' — ' + p.description : ''}`;
    }).join('\n');
    return `### ${f.name}\n${f.description}\n${args || '  (no arguments)'}`;
  }).join('\n\n');
  return `# How to use tools
To call a tool, write a block exactly like this:
<tool_call>
{"name": "read_file", "arguments": {"path": "index.html"}}
</tool_call>
Rules:
- The block must contain valid JSON. Inside strings escape newlines as \\n and quotes as \\".
- You may write one short sentence before your calls, and several <tool_call> blocks in one reply.
- After your tool calls, STOP writing. The results arrive in the next message inside <tool_result> blocks. Never write <tool_result> yourself and never guess results.
- When the task is done, reply normally with no <tool_call> block.

# Available tools
${docs}`;
}
