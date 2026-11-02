// End-to-end test (local mode, mock Ollama). Run from the repo root:
//   node test/mock-ollama.mjs 11555 &  python3 -m http.server 8765 &  node test/e2e.mjs
import { chromium } from 'playwright';

const APP = process.env.APP || 'http://localhost:8765/';
const API = process.env.API || 'http://localhost:11555';
const errors = [];
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓', msg); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
// Force local mode (no Firebase network in tests) via an invalid-but-empty override path.
await ctx.addInitScript(() => { window.__TEST__ = true; try { if (!localStorage.getItem('oc2.settings')) localStorage.setItem('oc2.settings', JSON.stringify({ idleTimeout: 3, defaultFiles: 'shared' })); } catch { /* sandboxed frames */ } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/firebase|gstatic|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(APP);
// With Firebase configured the sign-in screen appears (or local fallback if the SDK can't load).
await page.waitForSelector('#v-auth:not([hidden]) #a-card:not([hidden]), #v-connect:not([hidden])', { timeout: 15000 });
if (await page.isVisible('#a-local')) { await page.click('#a-local'); console.log('  (chose local mode on the sign-in screen)'); }
await page.waitForSelector('#v-connect:not([hidden])');
ok(true, 'connect screen shown');

await page.fill('#c-url', API);
await page.fill('#c-label', 'Mock');
await page.click('#c-go');
await page.waitForSelector('#v-models:not([hidden]) .mcard');
ok((await page.$$('.mcard')).length === 3, '3 model cards');
await page.waitForFunction(() => !document.body.textContent.includes('detecting…'));
ok(true, 'capabilities detected via /api/show');
ok(await page.isVisible('.strength .tier-A, .strength .tier-S, .strength .tier-B'), 'strength tier shown');

// sort by strength: strongest (27B with tools+thinking) first
await page.selectOption('#m-sort', 'strength');
ok((await page.textContent('.mcard .mname')).includes('mock-coder'), 'strength sort puts mock-coder first');

// rate + favorite mock-chat
const chatCard = page.locator('.mcard', { hasText: 'mock-chat:8b' });
await chatCard.locator('.star').nth(3).click();
await chatCard.locator('.fav').click();
await page.selectOption('#m-sort', 'smart');
ok((await page.textContent('.mcard .mname')).includes('mock-chat'), 'favorite sorts first');
ok((await page.locator('.mcard', { hasText: 'mock-chat:8b' }).locator('.star.on').count()) === 4, '4-star rating saved');

// pick the coder, set auto-approve, run the agent
await page.click('.mcard:has-text("mock-coder:27b")');
await page.waitForSelector('#v-ws:not([hidden])');
await page.selectOption('#perm', 'auto');
await page.fill('#inp', 'build a snake game');
await page.press('#inp', 'Enter');
await page.waitForSelector('.runfoot', { timeout: 20000 });
const chatText = await page.textContent('#chat');
ok(chatText.includes('All done.'), 'final answer rendered');
ok(await page.isVisible('.tool:has-text("read_file")'), 'tool calls written as text are executed (streamed mode)');
ok(chatText.includes('unfinished todo'), 'auto-continue on unfinished todos');
ok(await page.isVisible('#chat table'), 'markdown table rendered');
ok(await page.isVisible('#chat .codeblock'), 'code block rendered');
ok(await page.isVisible('.runfoot .fchip.created'), 'changed file chip in run summary');
const file = await page.evaluate(() => JSON.parse(localStorage.getItem('oc2.vfs'))['index.html']);
ok(file.includes('<h1>Snake</h1>'), 'edit applied to index.html');
ok((await page.textContent('#todo-count')) === '2/2', 'todos completed');
const meta = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('oc2.mmeta'))).find(m => m.model === 'mock-coder:27b'));
ok(meta.runs === 1 && meta.toolCalls >= 5 && meta.evalTokens > 0, 'model stats recorded (runs, tool calls, tokens)');

// permission prompt in "ask" mode
await page.click('#b-new');
await page.selectOption('#perm', 'ask');
await page.fill('#inp', 'snake again');
await page.press('#inp', 'Enter');
await page.waitForSelector('.perm button.ok', { timeout: 10000 });
ok(true, 'approval requested in ask mode');
await page.click('.perm button.ok');
await page.waitForSelector('.perm button.ok', { timeout: 10000 }); // edit_file asks too
await page.click('.perm button:has-text("Always allow edits")');
await page.waitForSelector('#chat .runfoot', { timeout: 20000 });
ok((await page.inputValue('#perm')) === 'edits', '"Always allow edits" switched permission mode');

// chat agent works with a no-tools model
await page.click('#b-new');
await page.click('#mchip');
await page.click('.pop-row:has-text("mock-chat:8b")');
await page.click('.pill:has-text("chat")');
await page.fill('#inp', 'hi');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot');
ok((await page.textContent('#chat')).includes('Hello from chat mode.'), 'chat agent with a no-tools model');

// reload: saved server resumes with last model; conversations persist
await page.reload();
await page.waitForSelector('#v-auth:not([hidden]) #a-card:not([hidden]), #v-connect:not([hidden])', { timeout: 15000 });
if (await page.isVisible('#a-local')) await page.click('#a-local');
await page.waitForSelector('.conn-main');
ok((await page.textContent('.conn-main')).includes('mock-chat:8b'), 'saved server remembers last model');
await page.click('.conn-main');
await page.waitForSelector('#v-ws:not([hidden])');
ok((await page.$$('.si')).length >= 3, 'conversations listed after reload');
await page.click('.si:has-text("build a snake game")');
await page.waitForSelector('#chat .runfoot');
ok((await page.textContent('#chat')).includes('All done.'), 'stored conversation re-rendered with summary');

// thinking hidden by default with live titles; code blocks run in a sandbox
await page.click('#b-new');
await page.click('#mchip');
await page.click('.pop-row:has-text("mock-coder:27b")');
await page.click('.pill:has-text("build")');
await page.selectOption('#perm', 'auto');
await page.fill('#inp', 'html demo');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot');
const think = page.locator('#chat details.think').last();
ok(!(await think.evaluate(d => d.open)), 'thinking collapsed by default');
ok((await think.locator('.tk-title').textContent()).includes('Draft the page'), 'thinking shows the latest title');
await think.locator('summary').click();
ok(await think.evaluate(d => d.open), 'tap on "Thinking" shows it');
await think.locator('summary').click();
ok(!(await think.evaluate(d => d.open)), 'tap again hides it');
const html = page.locator('.codeblock[data-run="html"]').last();
ok(await html.locator('.cb-gutter').isVisible(), 'code block has line numbers');
if (await page.evaluate(() => !!window.hljs)) ok((await html.locator('.hljs span').count()) > 0, 'code block is syntax-highlighted');
else console.log('  - highlight.js CDN not reachable here; skipped highlight check');
await html.locator('.cb-run').click();
const frame = html.locator('iframe.cbo-frame');
ok((await frame.getAttribute('sandbox')).includes('allow-scripts') && !(await frame.getAttribute('sandbox')).includes('allow-same-origin'), 'runs in a sandboxed iframe (no same-origin)');
ok((await html.locator('.cbo-bar').textContent()).includes('CSS + JS from this message'), 'HTML run merges CSS/JS blocks from the message');
await page.waitForFunction(() => document.querySelector('.cbo-console')?.textContent.includes('hello from sandbox 42'));
ok(true, 'console output bridged from the sandbox');
const fr = page.frameLocator('.codeblock[data-run="html"] iframe.cbo-frame').last();
ok((await fr.locator('button').evaluate(b => getComputedStyle(b).color)) === 'rgb(255, 0, 0)', 'merged CSS applied inside the sandbox');
ok(await fr.locator('body').evaluate(() => { try { return localStorage.length >= 0 && false; } catch { return true; } }), 'sandbox cannot read the app storage');
const js = page.locator('.codeblock[data-run="js"]').last();
await js.locator('.cb-edit').click();
await js.locator('.cb-edit-area').fill('console.log("edited", 1 + 1)');
await js.locator('.cb-run').click();
await page.waitForFunction(() => [...document.querySelectorAll('.cbo-console')].some(c => c.textContent.includes('edited 2')));
ok(true, 'edited JS runs');
await js.locator('.cb-edit').click();
ok((await js.locator('.cb-info').textContent()).includes('edited'), 'edit applied back to the highlighted view');

// save all code blocks of an answer to files
await page.click('.runfoot button:has-text("Save code to files")');
await page.click('.modal button.primary:has-text("Save")');
await page.waitForFunction(() => { const f = JSON.parse(localStorage.getItem('oc2.vfs')); return f['style.css'] && f['script.js']; });
ok(true, 'answer code blocks saved as index.html / style.css / script.js');

// files panel: download one file, zip all
if (await page.isVisible('#v-close')) await page.click('#v-close');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#f-zip')]);
await dl.saveAs(process.env.ZIP || '/tmp/ws.zip');
ok(dl.suggestedFilename().endsWith('.zip'), 'zip all downloads ' + dl.suggestedFilename());
await page.hover('.fi:has-text("style.css")');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('.fi:has-text("style.css") .fa button[title^="Download"]').click()]);
ok(dl2.suggestedFilename() === 'style.css', 'single file download');

// internet: web_fetch reads a page
await page.click('#b-new');
await page.fill('#inp', 'read the docs for the mock sdk');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot', { timeout: 20000 });
ok((await page.textContent('#chat')).includes('SDK_MAGIC_42 found'), 'web_fetch tool read the page');
ok((await page.locator('.tool:has-text("web_fetch") .tres').textContent()).includes('Mock SDK docs'), 'page converted to text with its title');

// streamed tool calls: progress is visible while a file is being written
await page.click('#b-new');
await page.fill('#inp', 'write a big file');
await page.press('#inp', 'Enter');
await page.waitForFunction(() => /write_file big\.txt/.test(document.querySelector('#runbar')?.textContent || ''), null, { timeout: 15000 });
ok(true, 'status bar shows the tool call being written (write_file big.txt …)');
await page.waitForFunction(() => /Writing tool call write_file big\.txt · [\d.k]+ chars · \d+ lines/.test(document.querySelector('#chat').textContent));
ok(true, 'chat shows live size of the file being written');
await page.waitForSelector('#chat .runfoot', { timeout: 20000 });
ok((await page.textContent('#chat')).includes('Big file written.'), 'big file run completed');
ok(!(await page.textContent('#chat .thread')).includes('"arguments"'), 'raw tool-call JSON is not shown in the answer');
ok((await page.evaluate(() => JSON.parse(localStorage.getItem('oc2.vfs'))['big.txt'])).split('\n').length === 60, 'big.txt written with 60 lines');

// native tool calling still works when selected
await page.click('#b-set');
await page.selectOption('.mbox select:near(:text("Tool calls"))', 'native');
await page.click('.mbox button.primary:has-text("Save")');
await page.click('#b-new');
await page.fill('#inp', 'read the docs again');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot', { timeout: 20000 });
ok((await page.textContent('#chat')).includes('SDK_MAGIC_42 found'), 'native tool calling mode works');
await page.click('#b-set');
await page.selectOption('.mbox select:near(:text("Tool calls"))', 'stream');
await page.click('.mbox button.primary:has-text("Save")');

// stall detection: no tokens for 3 s → automatic retry of the step
await page.click('#b-new');
await page.fill('#inp', 'stall test');
await page.press('#inp', 'Enter');
await page.waitForSelector('#runbar:not([hidden])');
await page.waitForFunction(() => document.querySelector('#runbar')?.textContent.includes('Thinking'));
ok(true, 'status bar shows the live phase (Thinking)');
await page.waitForFunction(() => /Retrying|retry/i.test(document.querySelector('#runbar')?.textContent || '') || document.body.textContent.includes('Recovered'), null, { timeout: 15000 });
await page.waitForSelector('#chat .runfoot', { timeout: 20000 });
ok((await page.textContent('#chat')).includes('Recovered after the stall.'), 'stalled step retried automatically and recovered');
ok(await page.isVisible('#chat .badge:has-text("retried")'), 'retried step is labelled');
ok(await page.isHidden('#runbar'), 'status bar hides when done');

// background runs: switch conversations while one is running
await page.click('#b-new');
await page.fill('#inp', 'slow job please');
await page.press('#inp', 'Enter');
await page.waitForFunction(() => document.querySelector('#running')?.textContent.includes('1 running'));
ok(true, 'running indicator shows 1 running');
await page.click('#b-new');
ok(await page.isVisible('#b-send'), 'new conversation is free while the other runs');
await page.fill('#inp', 'hi there');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot');
ok(await page.isVisible('.si.running'), 'running conversation marked in the sidebar');
await page.click('#running');
await page.click('.run-row');
await page.waitForFunction(() => document.querySelector('#chat').textContent.includes('slow job please'));
ok(true, 'switched back to the running conversation from the list');
await page.waitForFunction(() => document.querySelector('#chat').textContent.includes('Slow job finished.'), null, { timeout: 20000 });
ok(await page.isHidden('#running'), 'background run finished; indicator gone');

// scrolling while the agent writes: follow only at the bottom
await page.click('#b-new');
await page.fill('#inp', 'long story');
await page.press('#inp', 'Enter');
const chatEl = page.locator('#chat');
await page.waitForFunction(() => { const c = document.querySelector('#chat'); return c.scrollHeight > c.clientHeight * 2; }, null, { timeout: 15000 });
const gap = () => page.evaluate(() => { const c = document.querySelector('#chat'); return c.scrollHeight - c.scrollTop - c.clientHeight; });
ok(await gap() < 30, 'follows new output while at the bottom');
const box = await chatEl.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -60);                       // just a little
await page.waitForTimeout(250);
const top1 = await page.evaluate(() => document.querySelector('#chat').scrollTop);
await page.waitForTimeout(1200);                      // output keeps streaming
const top2 = await page.evaluate(() => document.querySelector('#chat').scrollTop);
ok(Math.abs(top2 - top1) < 2 && await gap() > 100, `a small scroll up stops following (stayed at ${Math.round(top2)}, ${Math.round(await gap())}px above the end)`);
ok(await page.isVisible('#chat .jump'), '"Jump to latest" appears');
await page.mouse.wheel(0, -400);
await page.waitForTimeout(300);
ok(await page.evaluate(() => document.querySelector('#chat').scrollTop) < top2, 'can keep scrolling up freely while it writes');
await page.click('#chat .jump');
await page.waitForTimeout(600);
ok(await gap() < 30 && await page.isHidden('#chat .jump'), 'Jump to latest resumes following');
await page.mouse.wheel(0, -200); await page.waitForTimeout(300);
await page.evaluate(() => { const c = document.querySelector('#chat'); c.scrollTop = c.scrollHeight; });
await page.mouse.wheel(0, 200); await page.waitForTimeout(800);
ok(await gap() < 30, 'scrolling back to the bottom resumes following');
await page.waitForSelector('#chat .runfoot', { timeout: 30000 });

// per-conversation files
await page.click('#b-new');
await page.click('#fs-scope button:has-text("This chat")');
ok((await page.textContent('#fs-label')).includes("This conversation's files"), 'conversation switched to its own private files');
await page.waitForFunction(() => document.querySelector('#tree').textContent.includes('No files yet'), null, { timeout: 5000 });
ok(true, 'private files start empty (shared files not visible)');
await page.setInputFiles('#f-in', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('private notes') });
await page.waitForSelector('.fi:has-text("notes.txt")');
ok(true, 'uploaded a file into this conversation');
await page.fill('#inp', 'write a big file');
await page.press('#inp', 'Enter');
await page.waitForSelector('#chat .runfoot', { timeout: 30000 });
await page.waitForSelector('.fi:has-text("big.txt")');
ok(true, 'agent wrote big.txt into this conversation');
const sharedNow = await page.evaluate(() => JSON.parse(localStorage.getItem('oc2.vfs') || '{}'));
ok(!sharedNow['notes.txt'], 'shared workspace untouched by the private conversation');
await page.click('.si:has-text("long story")');
await page.waitForFunction(() => document.querySelector('#fs-label').textContent.includes('Browser workspace'));
await page.waitForFunction(() => document.querySelector('#tree').textContent.includes('index.html'));
ok(!(await page.textContent('#tree')).includes('notes.txt'), 'another conversation does not see those files');
await page.click('.si:has-text("write a big file") >> nth=0');
await page.waitForSelector('.fi:has-text("notes.txt")');
ok(true, 'switching back shows the private files again');
await page.reload();
await page.waitForSelector('#v-auth:not([hidden]) #a-card:not([hidden]), #v-connect:not([hidden])', { timeout: 15000 });
if (await page.isVisible('#a-local')) await page.click('#a-local');
await page.waitForSelector('.conn-main'); await page.click('.conn-main');
await page.waitForSelector('#v-ws:not([hidden])');
await page.locator('.si', { hasText: 'write a big file' }).first().click();
await page.waitForSelector('.fi:has-text("notes.txt")');
ok(true, 'private files persist after reload (IndexedDB)');

// hide / show the files panel
await page.click('#t-files');
ok(await page.isHidden('#right'), 'files panel hidden');
await page.keyboard.press('Control+.');
ok(await page.isVisible('#right'), 'Ctrl+. shows it again');

// display settings
await page.click('#b-display');
await page.click('.seg button:has-text("Light")');
ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'light theme applies');
const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
await page.click('.slider button[title=Larger] >> nth=0');
const after = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
ok(parseFloat(after) > parseFloat(before), `text size grows (${before} → ${after})`);
await page.keyboard.press('Escape');

// phone layout: no horizontal overflow, 16px inputs (prevents iOS zoom)
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(200);
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'no horizontal overflow on a phone');
ok(parseFloat(await page.locator('#inp').evaluate(e => getComputedStyle(e).fontSize)) >= 16, 'composer font ≥ 16px on phones');
await page.screenshot({ path: process.env.SHOT || '/tmp/phone.png' });
await page.setViewportSize({ width: 1280, height: 800 });

// cloud module parses
await page.evaluate(() => import('./js/core/storage/cloud.js'));
ok(true, 'cloud storage module loads');

await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('ALL PASSED');
