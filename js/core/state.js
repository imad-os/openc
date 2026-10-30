// Shared app state + a tiny event bus. UI modules subscribe with on(), others emit().

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

export const DEFAULT_SETTINGS = Object.freeze({
  temperature: 0.2,
  num_ctx: 16384,
  maxSteps: 30,
  think: 'auto',          // auto | on | off | low | medium | high
  perm: 'ask',            // ask | edits | auto
  autoContinue: true,     // nudge the agent when it stops with unfinished todos
  autoCompact: true,      // summarize old messages when the context window fills up
  sound: true,
  volume: 0.6,
  desktopNotify: false,
});

export const state = {
  user: null,        // Firebase user (null in local mode)
  store: null,       // LocalStore | CloudStore
  conn: null,        // { id, url, key, label, lastModel, ... }
  models: [],        // [{ name, caps, details, size, ... }]
  running: {},       // models loaded in memory (/api/ps)
  modelMeta: {},     // model name -> { rating, fav, runs, evalTokens, ... } for current server
  model: null,
  settings: { ...DEFAULT_SETTINGS },
  agents: [],
  agentId: 'build',
  sessions: [],      // session metadata, newest first
  session: null,     // current session incl. messages
  fs: null,          // VirtualFS | DirFS
  openFile: null,
  busy: false,
  abort: null,
};

export const modelInfo = (name = state.model) => state.models.find(m => m.name === name);
export const modelCaps = (name = state.model) => modelInfo(name)?.caps || [];
export const primaryAgents = () => state.agents.filter(a => a.mode === 'primary');
export const subagents = () => state.agents.filter(a => a.mode === 'subagent');
export const currentAgent = () => state.agents.find(a => a.id === state.agentId && a.mode === 'primary') || primaryAgents()[0];

export async function saveSettings() {
  emit('settings');
  try { await state.store?.saveSettings(state.settings); } catch (e) { console.warn('saveSettings failed', e); }
}
