// Files panel: tree, editor, HTML preview, upload, open a real folder, todos tab.
import { state, on } from '../core/state.js';
import { $, h, toast, promptDialog } from '../util/dom.js';
import { normPath, VirtualFS, DirFS } from '../core/fs.js';
import { invalidateFileCache } from '../agent/runner.js';

let dirty = false, previewing = false, refreshTimer = 0;

export function initFiles() {
  $('#f-ref').addEventListener('click', refreshFiles);
  $('#f-new').addEventListener('click', newFile);
  $('#f-up').addEventListener('click', () => $('#f-in').click());
  $('#f-in').addEventListener('change', upload);
  $('#f-open').addEventListener('click', openFolder);
  $('#f-virt').addEventListener('click', () => switchFs(new VirtualFS()));
  $('#tab-files').addEventListener('click', () => tab('files'));
  $('#tab-todos').addEventListener('click', () => tab('todos'));
  $('#ved').addEventListener('input', () => { dirty = true; });
  $('#ved').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end'); dirty = true; }
  });
  $('#v-save').addEventListener('click', save);
  $('#v-close').addEventListener('click', closeViewer);
  $('#v-dl').addEventListener('click', () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([$('#ved').value])), download: state.openFile.split('/').pop() });
    a.click();
  });
  $('#v-prev').addEventListener('click', togglePreview);
  $('#v-tab').addEventListener('click', async () => {
    if (dirty) await save();
    window.open(URL.createObjectURL(new Blob([await inlineHTML(state.openFile)], { type: 'text/html' })));
  });
  on('fs-changed', p => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await refreshFiles();
      if (p && p === state.openFile && !$('#viewer').hidden && !dirty) openFile(p, true);
    }, 150);
  });
  on('open-file', p => openFile(p));
}

function tab(name) {
  $('#tab-files').classList.toggle('on', name === 'files');
  $('#tab-todos').classList.toggle('on', name === 'todos');
  $('#p-files').hidden = name !== 'files';
  $('#p-todos').hidden = name !== 'todos';
}

function switchFs(fs) {
  state.fs = fs;
  invalidateFileCache();
  closeViewer();
  refreshFiles();
}

export async function refreshFiles() {
  $('#fs-label').textContent = state.fs.label;
  $('#f-virt').hidden = !!state.fs.virtual;
  $('#f-open').hidden = !state.fs.virtual;
  let files = [];
  try { files = await state.fs.list(); } catch (e) { toast(e.message); }
  const tree = $('#tree');
  tree.innerHTML = '';
  if (!files.length) {
    tree.append(h('div', { class: 'dim pad' }, 'No files yet. Ask the agent to create something, upload files, or open a folder.'));
    return;
  }
  const root = {};
  for (const f of files) {
    let node = root;
    const parts = f.split('/');
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = f;
      else node = node[p] = typeof node[p] === 'object' ? node[p] : {};
    });
  }
  const el = h('div', { class: 'tree' });
  const draw = (node, parent, depth) => {
    const keys = Object.keys(node).sort((a, b) => {
      const da = typeof node[a] === 'object', db = typeof node[b] === 'object';
      return da === db ? a.localeCompare(b) : da ? -1 : 1;
    });
    for (const k of keys) {
      const v = node[k];
      if (typeof v === 'string') {
        parent.append(h('div', { class: 'fi' + (state.openFile === v ? ' sel' : ''), style: { paddingLeft: 8 + depth * 14 + 'px' }, onclick: () => openFile(v) }, k));
      } else {
        const d = h('details', { open: depth < 2 }, h('summary', { style: { paddingLeft: 8 + depth * 14 + 'px' } }, k + '/'));
        draw(v, d, depth + 1);
        parent.append(d);
      }
    }
  };
  draw(root, el, 0);
  tree.append(el);
}

export async function openFile(path, quiet = false) {
  try {
    const text = await state.fs.read(path);
    state.openFile = path;
    dirty = false;
    previewing = false;
    $('#v-name').textContent = path;
    $('#ved').value = text;
    $('#ved').hidden = false;
    $('#vpv').hidden = true;
    const html = /\.html?$/i.test(path);
    $('#v-prev').hidden = !html;
    $('#v-tab').hidden = !html;
    $('#v-prev').textContent = 'Preview';
    $('#viewer').hidden = false;
    $('#v-ws').classList.add('wide');
    $('#right').classList.add('open');
    tab('files');
    if (!quiet) refreshFiles();
  } catch (e) { toast(e.message); }
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#v-ws').classList.remove('wide');
  state.openFile = null;
  refreshFiles();
}

async function save() {
  try {
    await state.fs.write(state.openFile, $('#ved').value);
    dirty = false;
    invalidateFileCache();
    toast('Saved ' + state.openFile);
    refreshFiles();
  } catch (e) { toast(e.message); }
}

async function togglePreview() {
  previewing = !previewing;
  if (previewing) {
    if (dirty) await save();
    $('#vpv').srcdoc = await inlineHTML(state.openFile);
  }
  $('#vpv').hidden = !previewing;
  $('#ved').hidden = previewing;
  $('#v-prev').textContent = previewing ? 'Edit' : 'Preview';
}

async function replaceAsync(str, re, fn) {
  const matches = [...str.matchAll(re)];
  const values = await Promise.all(matches.map(m => fn(...m)));
  let i = 0;
  return str.replace(re, () => values[i++]);
}

/** Inline local CSS/JS so a multi-file page previews inside a sandboxed iframe. */
async function inlineHTML(path) {
  let html = await state.fs.read(path);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const files = await state.fs.list();
  const local = src => {
    if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith('data:')) return null;
    try { const p = normPath(dir + src.replace(/^\.?\//, '').split(/[?#]/)[0]); return files.includes(p) ? p : null; } catch { return null; }
  };
  html = await replaceAsync(html, /<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]*>/gi, async (m, src) => {
    const p = local(src);
    return p ? '<style>' + (await state.fs.read(p)) + '</style>' : m;
  });
  html = await replaceAsync(html, /<script([^>]*?)\ssrc=["']([^"']+)["']([^>]*)><\/script>/gi, async (m, a, src, b) => {
    const p = local(src);
    return p ? `<script${a}${b}>` + (await state.fs.read(p)).replace(/<\/script/gi, '<\\/script') + '</script>' : m;
  });
  return html;
}

async function newFile() {
  const name = await promptDialog('New file path (e.g. src/app.js)');
  if (!name) return;
  try {
    const p = normPath(name);
    if (await state.fs.exists(p)) return openFile(p);
    await state.fs.write(p, '');
    invalidateFileCache();
    await refreshFiles();
    openFile(p);
  } catch (e) { toast(e.message); }
}

async function upload(e) {
  for (const f of e.target.files) {
    if (f.size > 2e6) { toast(`${f.name} is larger than 2 MB, skipped`); continue; }
    try { await state.fs.write(normPath(f.name), await f.text()); } catch (x) { toast(x.message); }
  }
  e.target.value = '';
  invalidateFileCache();
  refreshFiles();
}

async function openFolder() {
  if (!window.showDirectoryPicker) return toast('This browser cannot open local folders (use Chrome or Edge). The browser workspace still works.', 4500);
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    switchFs(new DirFS(handle));
    toast('Opened ' + handle.name);
  } catch { /* cancelled */ }
}
