// Entry point: wire up the UI, then choose cloud (Firebase) or local storage.
import { state, emit, DEFAULT_SETTINGS } from './core/state.js';
import { LocalStore } from './core/storage/local.js';
import { CloudStore } from './core/storage/cloud.js';
import { getFirebaseConfig, initAuth, firebase, authErrorText } from './core/auth.js';
import { VirtualFS } from './core/fs.js';
import { rebuildAgents } from './agent/agents.js';
import { toast } from './util/dom.js';
import { initAuthUI, showAuth } from './ui/auth.js';
import { initConnect, showConnect } from './ui/connect.js';
import { initModels } from './ui/models.js';
import { initWorkspace } from './ui/workspace.js';
import { initComposer } from './ui/composer.js';
import { initFiles } from './ui/files.js';
import { initSessions, loadSessions } from './ui/sessions.js';
import { initChat } from './ui/chat.js';
import { applyDisplay } from './ui/display.js';

async function loadUserData() {
  let settings = {};
  try { settings = await state.store.getSettings(); } catch (e) { console.warn(e); }
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  let agents = [];
  try { agents = await state.store.listAgents(); } catch (e) { console.warn(e); }
  rebuildAgents(agents);
  state.conn = null;
  state.model = null;
  state.session = null;
  await loadSessions();
  emit('settings');
  emit('agents');
}

async function useStore(store) {
  state.store = store;
  try { await store.init(); }
  catch (e) {
    console.error(e);
    toast(`Storage error: ${e.message}${store.kind === 'cloud' ? ' (are the Firestore rules deployed?)' : ''}`, 8000);
  }
  await loadUserData();
  emit('user');
  showConnect();
}

export const startLocal = () => { state.user = null; return useStore(new LocalStore()); };

async function onAuthChange(user) {
  if (user) {
    if (state.user?.uid === user.uid) return;
    state.abort?.abort();
    state.user = user;
    await useStore(new CloudStore(firebase(), user));
    return;
  }
  const wasSignedIn = !!state.user;
  state.user = null;
  if (wasSignedIn) {
    state.abort?.abort();
    state.store = null;
    state.session = null;
    state.conn = null;
    emit('user');
  } else if (state.store?.kind === 'local') return; // user chose local mode
  showAuth();
}

async function boot() {
  applyDisplay();
  state.fs = new VirtualFS();
  try { state.agentId = localStorage.getItem('oc2.agent') || 'build'; } catch { /* ignore */ }
  initChat();
  initAuthUI({ onLocal: startLocal });
  initConnect();
  initModels();
  initWorkspace();
  initComposer();
  initFiles();
  initSessions();

  if (!getFirebaseConfig()) return startLocal();
  showAuth({ loading: true });
  try {
    const fb = await initAuth(onAuthChange);
    fb.A.getRedirectResult(fb.auth).catch(e => toast(authErrorText(e), 6000));
  } catch (e) {
    console.error(e);
    toast(`Could not load Firebase (${e.message}). Using local mode.`, 6000);
    startLocal();
  }
}

boot();
