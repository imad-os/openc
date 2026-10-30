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
await ctx.addInitScript(() => { window.__TEST__ = true; });
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
ok(chatText.includes('tool call recovered from text'), 'text tool call recovered');
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
