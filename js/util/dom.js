// Small DOM helpers: element builder, toasts, modals, popovers, dialogs.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class:'x', onclick: fn}, child1, [child2, ...]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(text, ms = 2800) {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

/** modal((box, close) => { box.append(...) }, { onClose }) */
export function modal(build, { onClose } = {}) {
  const box = h('div', { class: 'mbox', role: 'dialog' });
  const el = h('div', { class: 'modal' }, box);
  let closed = false;
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  el.addEventListener('mousedown', e => { if (e.target === el) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  build(box, close);
  return close;
}

export function confirmDialog(text, okLabel = 'OK') {
  return new Promise(resolve => {
    let value = false;
    modal((box, close) => {
      const done = v => { value = v; close(); };
      box.append(h('div', {}, text), h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => done(true) }, okLabel)));
    }, { onClose: () => resolve(value) });
  });
}

export function promptDialog(title, value = '') {
  return new Promise(resolve => {
    let result = null;
    modal((box, close) => {
      const input = h('input', { value });
      const done = v => { result = v; close(); };
      box.append(h('h3', {}, title), h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); done(input.value.trim() || null); } },
        input, h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save'))));
      setTimeout(() => { input.focus(); input.select(); });
    }, { onClose: () => resolve(result) });
  });
}

/** Floating panel anchored under an element; closes on outside click / Escape. */
export function popover(anchor, build) {
  document.querySelectorAll('.popover').forEach(p => p._close?.());
  const el = h('div', { class: 'popover' });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.min(r.bottom + 6, innerHeight - 160) + 'px';
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
  const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey); };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  document.addEventListener('keydown', onKey);
  el._close = close;
  build(el, close);
  return close;
}
