# Ollama Code

An opencode-style coding agent in the browser for any [Ollama](https://ollama.com) server. It has agents, tools, subagents, model ratings, and optional Firebase sign-in and sync.

## Features

- **Servers:** save several Ollama URLs with an optional API key and label. Each server remembers its last model, so one click resumes.
- **Models:**
  - Capability tags (tools, thinking, vision, audio…), size, quantization and context length.
  - **Estimated strength** (0–100, tier S–D). It is based on size, quantization, model generation, capabilities and context, refined by the measured tool success and your stars. Hover a score for the breakdown.
  - **Your ★ rating, ♥ favorites and measured speed** (tok/s, runs, tool success), stored per server.
  - Sort by favorites and rating, strength, speed, rating, recently used, newest, name or size. Filter by favorites, rated, used before, tier A/S or capability.
- **Agents:**
  - `build` has full access, `plan` is read-only, and `chat` has no tools, so it works with any model.
  - The subagents `explore` and `general` are called through the `task` tool.
  - You can create your own agents with a custom prompt, model, temperature and tools.
- **Agent loop:**
  - Streaming with thinking shown live.
  - Read-only tools run in parallel.
  - Edits wait for approval (ask / auto-accept edits / auto-accept all).
  - Tool calls that a model writes as text are recovered: `<tool_call>`, `[TOOL_CALLS]`, bare JSON.
  - Loop guard against repeated identical calls, and a nudge after an empty reply.
  - Auto-continue while todos are unfinished.
  - Old tool output is pruned and the conversation is auto-compacted when the context window fills up.
  - Retries with backoff, and a fallback to chat-only mode when a model rejects tools.
  - Read-before-edit and whitespace-tolerant edits.
- **Internet:** `web_search` and `web_fetch` let agents look up SDK docs, READMEs and API references. See [Internet access](#internet-access).
- **Live status:** a bar above the composer shows what the agent is doing right now (waiting for the model, thinking, writing, running a tool, waiting for your approval…), with timers, token speed and the time since the last token. While waiting it reports whether the model is loaded in memory. A watchdog retries a step automatically when the model stops sending tokens, and you can **Retry step** or **Stop** by hand.
- **Parallel conversations:** agents keep running when you switch conversations, models or servers. A "N running" button lists them with their live status, and you can switch between them or stop them.
- **Tools:** `list_files`, `find_files`, `read_file`, `grep`, `write_file`, `edit_file`, `move_file`, `delete_file`, `run_js` (sandboxed worker with access to workspace files), `todo_write`, `ask_user`, `task`, `web_search` and `web_fetch`.
- **Answers:** Markdown with tables and highlighted code, and a run summary (time, steps, tool calls, tokens, tok/s, changed files).
- **Notifications:** a chime when the agent finishes, fails, or needs approval or an answer, plus optional desktop notifications.
- **Files:** per-file download, rename and delete, a .zip of a folder or of everything, and "Save code to files" on any answer that contains code blocks.
- **Workspace:** a browser-stored workspace or a real local folder (Chrome/Edge). It has an editor and a live HTML preview.
- **Sync (optional):** Google or email/password sign-in. Servers, API keys, ratings, stats, agents and conversations are stored in Firestore under your account only.

## Run it

ES modules don't load from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

Alternatively, deploy it to GitHub Pages or Firebase Hosting (below).

Ollama must allow the page's origin:

```bash
OLLAMA_ORIGINS="*" ollama serve
```

Not connecting? Click **🩺 Test CORS** on the servers screen, or open `cors-test.html`. It tells apart "server down", "CORS blocked", "mixed content" and "bad API key", and shows the exact `OLLAMA_ORIGINS` / `OLLAMA_HOST` commands for Linux, macOS, Windows and Docker. It also has a speed test (time to first token, tokens/s).

If the page is served over **https**, the Ollama URL must also be https, because browsers block mixed content. A reverse proxy or tunnel works.

## Internet access

Browsers block most cross-site requests (CORS), so `web_fetch` tries several routes in order:

1. The page directly, which works for CORS-enabled hosts such as GitHub raw, jsDelivr, unpkg and many APIs.
2. Ollama's web fetch, if you add an **ollama.com API key** (free account → ollama.com/settings/keys).
3. **Jina Reader** (`r.jina.ai`), which is free and needs no key. A Jina key raises its rate limits.
4. Your own CORS proxy. `proxy/cloudflare-worker.js` is a ready-to-deploy free Cloudflare Worker.

`web_search` uses Ollama web search when a key is set, then Jina search (key), your SearXNG instance, and finally free fallbacks: DuckDuckGo through Jina Reader, then Wikipedia. Configure these in **Settings → Internet** and press **Test internet access**.

## Firebase setup (sign-in and sync)

`js/config.js` holds the web config for project `agents-df3d3`. Firebase web configs are public identifiers. Your data is protected by `firestore.rules`.

1. **Authentication → Sign-in method:** enable **Google** and **Email/Password**.
2. **Authentication → Settings → Authorized domains:** add the domain you serve from (for example `imad-os.github.io`). `localhost` is allowed by default.
3. **Firestore Database:** create the database (production mode).
4. **Deploy the security rules** (required, or reads and writes are denied):
   ```bash
   npm i -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules
   ```
   You can also paste `firestore.rules` into the console under Firestore → Rules → Publish.
5. Optionally host it with `firebase deploy --only hosting`. It is served at `https://agents-df3d3.web.app`, which is already an authorized domain.

To run without accounts, set `apiKey: ''` in `js/config.js` or click "Continue without an account". Data then stays in the browser's localStorage, and you can copy it into your account later from **Account**.

### Security rules summary

- All data lives under `/users/{uid}/…`, and only the signed-in owner (`request.auth.uid == uid`) can read or write it.
- Listing users and every other path are denied.
- Every write is schema-checked: only known fields, correct types, string and list size limits, `http(s)` URLs, ratings from 0 to 5, and message roles from a fixed list.

The API keys you save are readable only by you, but they are stored in your Firestore. Untick "Save the API key" if you'd rather enter a key each time.

## Code layout

```
index.html              markup for the 4 screens (sign-in, servers, models, workspace)
css/styles.css
js/main.js              boot: local vs cloud storage, auth state
js/config.js            Firebase web config
js/core/                state + event bus, Ollama client, file systems, auth, strength score
js/core/storage/        LocalStore (localStorage) and CloudStore (Firestore), same interface
js/agent/               agents & prompts, tools, runner (agent loop), context mgmt, text tool-call parser
js/ui/                  auth, connect, models, workspace, sessions, composer, chat, files, modals
js/util/                DOM helpers, markdown, sound, misc
firestore.rules         security rules
test/                   mock Ollama server + Playwright end-to-end test
```

## Tests

```bash
node test/mock-ollama.mjs 11555 &
python3 -m http.server 8765 &
node test/e2e.mjs        # needs playwright
```
