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
