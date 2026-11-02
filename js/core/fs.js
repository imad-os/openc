// Workspace file systems: a browser-stored virtual FS, and a real local folder (File System Access API).

const SKIP = /(^|\/)(node_modules|\.git|\.next|\.cache|dist|build|__pycache__|\.venv|venv|\.DS_Store)(\/|$)/;

export function normPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (s.split('/').some(seg => seg === '..')) throw new Error('Path must stay inside the workspace');
  return s === '.' ? '' : s;
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Glob → RegExp. Supports *, **, ?, {a,b}. */
export function globToRegex(glob) {
  glob = String(glob || '*').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) { re += '(' + glob.slice(i + 1, end).split(',').map(escRe).join('|') + ')'; i = end; }
      else re += '\\{';
    } else re += escRe(c);
  }
  return new RegExp('^' + re + '$', 'i');
}

export class VirtualFS {
  constructor(key = 'oc2.vfs') {
    this.key = key;
    this.virtual = true;
    this.label = 'Browser workspace (saved in this browser)';
    try { this.files = JSON.parse(localStorage.getItem(key) ?? localStorage.getItem('oc.vfs') ?? '{}'); } catch { this.files = {}; }
  }
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.files)); }
    catch { throw new Error('Browser storage is full. Delete some files or open a real folder.'); }
  }
  async list() { return Object.keys(this.files).sort(); }
  async exists(p) { return Object.prototype.hasOwnProperty.call(this.files, p); }
  async read(p) { if (!(await this.exists(p))) throw new Error('File not found: ' + p); return this.files[p]; }
  async readBytes(p) { return new TextEncoder().encode(await this.read(p)); }
  async size(p) { return new Blob([await this.read(p)]).size; }
  async write(p, content) { if (!p) throw new Error('Empty path'); this.files[p] = String(content); this.save(); }
  async remove(p) { if (!(await this.exists(p))) throw new Error('File not found: ' + p); delete this.files[p]; this.save(); }
  async move(from, to) { const c = await this.read(from); this.files[to] = c; delete this.files[from]; this.save(); }
}

export class DirFS {
  constructor(handle) {
    this.root = handle;
    this.label = 'Folder: ' + handle.name;
    this.cache = null;
  }
  async walk(dir, prefix, out, depth) {
    if (depth > 10 || out.length > 5000) return;
    for await (const [name, hd] of dir.entries()) {
      const path = prefix + name;
      if (SKIP.test(path)) continue;
      if (hd.kind === 'file') out.push(path);
      else await this.walk(hd, path + '/', out, depth + 1);
    }
  }
  async list() {
    if (this.cache && Date.now() - this.cache.t < 1500) return this.cache.list;
    const out = [];
    await this.walk(this.root, '', out, 0);
    out.sort();
    this.cache = { t: Date.now(), list: out };
    return out;
  }
  async dir(path, create) {
    let d = this.root;
    for (const seg of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(seg, { create });
    return d;
  }
  async fileHandle(p, create) {
    const parts = p.split('/');
    const name = parts.pop();
    return (await this.dir(parts.join('/'), create)).getFileHandle(name, { create });
  }
  async exists(p) { try { await this.fileHandle(p, false); return true; } catch { return false; } }
  async read(p) {
    try { return await (await (await this.fileHandle(p, false)).getFile()).text(); }
    catch { throw new Error('File not found: ' + p); }
  }
  async readBytes(p) {
    try { return new Uint8Array(await (await (await this.fileHandle(p, false)).getFile()).arrayBuffer()); }
    catch { throw new Error('File not found: ' + p); }
  }
  async size(p) { try { return (await (await this.fileHandle(p, false)).getFile()).size; } catch { return 0; } }
  async write(p, content) {
    if (!p) throw new Error('Empty path');
    this.cache = null;
    const w = await (await this.fileHandle(p, true)).createWritable();
    await w.write(String(content));
    await w.close();
  }
  async remove(p) {
    this.cache = null;
    const parts = p.split('/');
    const name = parts.pop();
    try { await (await this.dir(parts.join('/'), false)).removeEntry(name); }
    catch { throw new Error('File not found: ' + p); }
  }
  async move(from, to) { const c = await this.read(from); await this.write(to, c); await this.remove(from); }
}

/* ---------- per-conversation files (IndexedDB, one record per conversation) ---------- */
const IDB_NAME = 'ollama-code', IDB_STORE = 'session-files';
let dbPromise = null;
function idb() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const req = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Files that belong to one conversation only. Stored in this browser (IndexedDB). */
export class SessionFS {
  constructor(sessionId) {
    this.id = sessionId;
    this.virtual = true;
    this.perSession = true;
    this.label = "This conversation's files (private to this chat)";
    this.files = null;
    this.loading = null;
  }
  async load() {
    if (this.files) return this.files;
    this.loading ||= idbDo('readonly', s => s.get(this.id)).then(v => (this.files = v || {})).catch(() => (this.files = {}));
    return this.loading;
  }
  async persist() {
    try { await idbDo('readwrite', s => s.put(this.files, this.id)); }
    catch (e) { throw new Error('Could not save conversation files in this browser: ' + (e?.message || e)); }
  }
  async list() { return Object.keys(await this.load()).sort(); }
  async exists(p) { return Object.prototype.hasOwnProperty.call(await this.load(), p); }
  async read(p) { if (!(await this.exists(p))) throw new Error('File not found: ' + p); return this.files[p]; }
  async readBytes(p) { return new TextEncoder().encode(await this.read(p)); }
  async size(p) { return new Blob([await this.read(p)]).size; }
  async write(p, content) { if (!p) throw new Error('Empty path'); await this.load(); this.files[p] = String(content); await this.persist(); }
  async remove(p) { if (!(await this.exists(p))) throw new Error('File not found: ' + p); delete this.files[p]; await this.persist(); }
  async move(from, to) { const c = await this.read(from); this.files[to] = c; delete this.files[from]; await this.persist(); }
}

export async function deleteSessionFiles(sessionId) {
  try { await idbDo('readwrite', s => s.delete(sessionId)); } catch { /* ignore */ }
}
