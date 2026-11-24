// Proxy selector popover (in chat) and Proxy Management dialog (add, edit, delete, set default).
import { state, on } from '../core/state.js';
import {
  getProxies, getDefaultProxy, getActiveProxy, proxyLabel,
  selectProxy, setDefaultProxy, saveProxyItem, deleteProxyItem,
} from '../core/proxy.js';
import { $, h, modal, popover, toast, confirmDialog } from '../util/dom.js';

export function initProxies() {
  on('proxy', paintProxyControls);
  on('settings', paintProxyControls);
  on('conn', paintProxyControls);
}

export function paintProxyControls() {
  const active = getActiveProxy();
  const btn = $('#proxybtn');
  if (btn) {
    btn.classList.toggle('on', !!active);
    btn.replaceChildren(
      h('span', { class: 'px-ic' }, '⇄'),
      h('span', { class: 'ellipsis' }, active ? proxyLabel(active) : 'Direct'),
      h('span', { class: 'caret' }, '▾'),
    );
    btn.title = active
      ? `CORS proxy (all servers): ${proxyLabel(active)} (${active.url}). Click to switch.`
      : 'CORS proxy: Direct (none). Click to select a proxy.';
  }
  const sb = $('#srv-proxy');
  if (sb) {
    sb.classList.toggle('on', !!active);
    sb.replaceChildren(
      h('span', { class: 'dim' }, 'Proxy: '),
      h('span', { class: 'ellipsis' }, active ? proxyLabel(active) : 'Direct'),
      h('span', { class: 'caret' }, '▾'),
    );
    sb.title = active ? active.url : 'No CORS proxy active. Click to switch or manage proxies.';
  }
}

export function openProxyPicker(anchor) {
  popover(anchor, (el, close) => {
    const list = h('div', { class: 'pop-list' });
    const proxies = getProxies();
    const active = getActiveProxy();
    const defId = state.settings.defaultProxyId || '';

    list.append(h('div', { class: 'pop-sec' }, 'CORS proxy (all servers)'));
    list.append(h('div', {
      class: 'pop-row' + (!active ? ' on' : ''),
      onclick: () => { close(); selectProxy(''); toast('Proxy off (Direct connection)'); },
    },
    h('div', { class: 'pr-main' },
      h('span', { class: 'pr-name' }, 'Direct (no proxy)'),
      !defId ? h('span', { class: 'tag unk mini' }, 'default') : null,
      !active ? h('span', { class: 'hc-sel' }, '✓') : null),
    h('div', { class: 'dim small' }, 'Connect directly to servers without a proxy')));

    if (proxies.length) {
      list.append(h('div', { class: 'pop-sec' }, 'Added proxies'));
      for (const p of proxies) {
        const isSel = active?.id === p.id;
        const isDef = defId === p.id;
        list.append(h('div', {
          class: 'pop-row' + (isSel ? ' on' : ''),
          onclick: () => { close(); selectProxy(p.id); toast(`Proxy: ${proxyLabel(p)}`); },
        },
        h('div', { class: 'pr-main' },
          h('span', { class: 'pr-name' }, proxyLabel(p)),
          isDef ? h('span', { class: 'tag srvtag mini' }, 'default') : null,
          isSel ? h('span', { class: 'hc-sel' }, '✓') : null),
        h('div', { class: 'dim small ellipsis' }, p.url)));
      }
    } else {
      list.append(h('div', { class: 'dim small pad' }, 'No proxies added yet.'));
    }

    el.append(
      list,
      h('button', {
        class: 'btn sm ghost wide', type: 'button',
        onclick: () => { close(); openProxyManager(); },
      }, '⚙ Manage proxies…'));
  });
}

export function openProxyManager() {
  modal((box, close) => {
    let editingId = '';
    const listBox = h('div', { class: 'hosts' });
    const formTitle = h('div', { class: 'sec-title' });
    const labelIn = h('input', { placeholder: 'e.g. Home PC proxy (optional)' });
    const urlIn = h('input', { placeholder: 'http://localhost:11435 or https://proxy.example/?url={url}' });
    const defCb = h('input', { type: 'checkbox' });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add proxy');
    const cancelEditBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Cancel edit');

    const resetForm = () => {
      editingId = '';
      formTitle.textContent = 'Add proxy';
      labelIn.value = '';
      urlIn.value = '';
      defCb.checked = !getProxies().length;
      saveBtn.textContent = 'Add proxy';
      cancelEditBtn.hidden = true;
    };

    const startEdit = p => {
      editingId = p.id;
      formTitle.textContent = 'Edit proxy';
      labelIn.value = p.label || '';
      urlIn.value = p.url || '';
      defCb.checked = state.settings.defaultProxyId === p.id;
      saveBtn.textContent = 'Save changes';
      cancelEditBtn.hidden = false;
      urlIn.focus();
    };

    const paint = () => {
      const proxies = getProxies();
      const active = getActiveProxy();
      const def = getDefaultProxy();
      const items = [
        h('div', { class: 'hcard' + (!active ? ' sel' : '') },
          h('div', { class: 'hc-main', onclick: () => { selectProxy(''); paint(); } },
            h('div', { class: 'hc-top' },
              h('b', {}, 'Direct (no proxy)'),
              !def ? h('span', { class: 'tag unk mini' }, 'default') : null,
              !active ? h('span', { class: 'hc-sel' }, '✓ Active') : null),
            h('div', { class: 'dim small' }, 'Connect directly to Ollama servers')),
          def ? h('button', {
            class: 'btn sm ghost', type: 'button', title: 'Make Direct (no proxy) the default',
            onclick: () => { setDefaultProxy(''); paint(); toast('Default set to Direct (no proxy)'); },
          }, 'Set default') : null),
      ];

      for (const p of proxies) {
        const isActive = active?.id === p.id;
        const isDef = def?.id === p.id;
        items.push(h('div', { class: 'hcard' + (isActive ? ' sel' : '') },
          h('div', { class: 'hc-main', onclick: () => { selectProxy(p.id); paint(); } },
            h('div', { class: 'hc-top' },
              h('b', {}, proxyLabel(p)),
              isDef ? h('span', { class: 'tag srvtag mini' }, '★ Default') : null,
              isActive ? h('span', { class: 'hc-sel' }, '✓ Active') : null),
            h('div', { class: 'dim small ellipsis' }, p.url)),
          h('div', { class: 'conn-act' },
            !isDef ? h('button', {
              class: 'btn sm', type: 'button', title: 'Use as default proxy',
              onclick: () => { setDefaultProxy(p.id); paint(); toast(`Default proxy: ${proxyLabel(p)}`); },
            }, 'Default') : null,
            h('button', { class: 'btn sm ghost', type: 'button', title: 'Edit proxy', onclick: () => startEdit(p) }, '✎'),
            h('button', {
              class: 'btn sm ghost danger', type: 'button', title: 'Delete proxy',
              onclick: async () => {
                if (!(await confirmDialog(`Delete proxy "${proxyLabel(p)}"?`, 'Delete'))) return;
                if (editingId === p.id) resetForm();
                await deleteProxyItem(p.id);
                paint();
              },
            }, '×'))));
      }

      listBox.replaceChildren(...items);
    };

    cancelEditBtn.addEventListener('click', resetForm);

    const form = h('form', {
      class: 'stack proxy-box',
      onsubmit: e => {
        e.preventDefault();
        try {
          const item = saveProxyItem({
            id: editingId,
            label: labelIn.value,
            url: urlIn.value,
            makeDefault: defCb.checked,
          });
          toast(editingId ? `Updated ${proxyLabel(item)}` : `Added ${proxyLabel(item)}`);
          resetForm();
          paint();
        } catch (err) {
          toast(err.message);
        }
      },
    },
    formTitle,
    h('div', { class: 'grid2' },
      h('label', { class: 'fld' }, 'Proxy URL', urlIn),
      h('label', { class: 'fld' }, 'Label (optional)', labelIn)),
    h('label', { class: 'check' }, defCb, 'Set as default proxy to use'),
    h('div', { class: 'row end' }, cancelEditBtn, saveBtn));

    box.append(
      h('h3', {}, 'Proxy management'),
      h('div', { class: 'dim small' }, 'The selected proxy applies globally to all Ollama servers. Choose a default proxy to use, or click any proxy to switch right away.'),
      listBox,
      form,
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Done')));

    resetForm();
    paint();
  });
}
