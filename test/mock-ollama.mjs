// Minimal scripted Ollama server for end-to-end tests: node test/mock-ollama.mjs [port]
import http from 'node:http';

const PORT = +process.argv[2] || 11434;
const MODELS = [
  { name: 'mock-coder:27b', size: 17e9, modified_at: '2026-09-01T00:00:00Z', details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M', context_length: 262144 }, capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'mock-chat:8b', size: 5e9, modified_at: '2026-08-01T00:00:00Z', details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_K_M', context_length: 8192 }, capabilities: ['completion'] },
  { name: 'mock-old:7b', size: 4e9, modified_at: '2026-07-01T00:00:00Z', details: { family: 'llama', parameter_size: '7.2B', quantization_level: 'Q4_K_M' } }, // no capabilities → /api/show
];

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const call = (name, args) => ({ function: { name, arguments: args } });

let stallCount = 0;

function script(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const tools = msgs.filter(m => m.role === 'tool');
  const lastTool = tools[tools.length - 1];
  if (last.role === 'user' && /stall test/i.test(last.content)) {
    stallCount++;
    return stallCount === 1 ? { thinking: 'Starting to think about it…', stallAfter: true } : { content: 'Recovered after the stall.' };
  }
  if (last.role === 'user' && /slow job/i.test(last.content)) {
    return { thinking: '**Planning the work** ' + 'step '.repeat(30), content: 'Slow job finished.', delay: 120 };
  }
  if (/read the docs/i.test(msgs.find(m => m.role === 'user')?.content || '') && body.tools) {
    if (last.role === 'user') return { content: '', tool_calls: [call('web_fetch', { url: `http://localhost:${PORT}/docs` })] };
    if (last.role === 'tool') return { content: 'The docs say: ' + (last.content.includes('SDK_MAGIC_42') ? 'SDK_MAGIC_42 found' : 'nothing') };
  }
  if (!body.tools) return { content: 'Hello from **chat** mode.' };
  if (last.role === 'user' && /demo/i.test(last.content)) {
    return {
      thinking: 'Thinking Process:\n\n1.  **Analyze the input:** The user wants a demo.\n2.  **Draft the page:** Simple HTML with a button.\n',
      content: 'Here is a page:\n\n```html\n<!doctype html>\n<html><body>\n<button id="b">Click</button>\n</body></html>\n```\n\n```css\nbutton { color: red }\n```\n\n```js\nconsole.log("hello from sandbox", 6 * 7);\n```',
    };
  }
  if (last.role === 'user' && /snake/i.test(last.content)) {
    return {
      thinking: 'The user wants a game. I will plan, then write index.html.',
      content: '',
      tool_calls: [
        call('todo_write', { todos: [{ content: 'Write index.html', status: 'in_progress' }, { content: 'Polish title', status: 'pending' }] }),
        call('write_file', { path: 'index.html', content: '<!doctype html>\n<title>Hello</title>\n<h1>Hello</h1>\n' }),
      ],
    };
  }
  if (last.role === 'tool' && lastTool.tool_name === 'write_file') {
    return { content: 'Let me check the file.\n<tool_call>{"name": "read_file", "arguments": {"path": "index.html"}}</tool_call>' };
  }
  if (last.role === 'tool' && lastTool.tool_name === 'read_file') {
    return { content: '', tool_calls: [call('edit_file', { path: 'index.html', old_string: '<h1>Hello</h1>', new_string: '<h1>Snake</h1>' })] };
  }
  if (last.role === 'tool' && lastTool.tool_name === 'edit_file') {
    return { content: 'Done! Created **index.html**.' }; // todos still open → app should auto-continue
  }
  if (last.role === 'user' && /todo items are not completed/.test(last.content)) {
    return { content: '', tool_calls: [call('todo_write', { todos: [{ content: 'Write index.html', status: 'completed' }, { content: 'Polish title', status: 'completed' }] })] };
  }
  if (last.role === 'tool' && lastTool.tool_name === 'todo_write') {
    return { content: 'All done.\n\n| File | Change |\n|---|---|\n| index.html | created |\n\n```js\nconsole.log("ok")\n```' };
  }
  return { content: 'OK.' };
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    const json = (o, code = 200) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/docs') { res.writeHead(200, { ...cors, 'content-type': 'text/html' }); return res.end('<html><head><title>Mock SDK docs</title></head><body><nav>menu</nav><main><h1>Mock SDK</h1><p>Use <code>client.go()</code>. Token: SDK_MAGIC_42</p><pre>npm i mock-sdk</pre></main></body></html>'); }
    if (req.url === '/api/tags') return json({ models: MODELS });
    if (req.url === '/api/ps') return json({ models: [{ name: 'mock-coder:27b' }] });
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 32768 } });
    if (req.url !== '/api/chat') return json({ error: 'not found' }, 404);
    const body = JSON.parse(raw || '{}');
    const r = script(body);
    if (body.stream === false) return json({ message: { role: 'assistant', content: r.content }, done: true });
    res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson' });
    const send = o => res.write(JSON.stringify({ model: body.model, ...o }) + '\n');
    const wait = ms => new Promise(r2 => setTimeout(r2, ms));
    if (r.thinking) for (const w of r.thinking.split(/(?<= )/)) { send({ message: { role: 'assistant', content: '', thinking: w }, done: false }); await wait(r.delay || 5); }
    if (r.stallAfter) { await wait(8000); try { res.end(); } catch {} return; }
    for (const w of (r.content || '').split(/(?<= )/)) { if (w) send({ message: { role: 'assistant', content: w }, done: false }); await wait(5); }
    if (r.tool_calls) send({ message: { role: 'assistant', content: '', tool_calls: r.tool_calls }, done: false });
    send({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 120, eval_duration: 2e9 });
    res.end();
  });
}).listen(PORT, () => console.log('mock ollama on', PORT));
