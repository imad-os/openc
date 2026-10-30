// Display preferences (per device, not synced): theme, text size, code size, density,
// chat width, thinking visibility, line numbers, code wrapping.
import { emit } from '../core/state.js';

const KEY = 'oc2.display';
const HL = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/';
const WIDTHS = { normal: '900px', wide: '1200px', full: '100%' };

export const DISPLAY_DEFAULTS = Object.freeze({
  theme: 'dark',          // dark | light | auto
  fontSize: 14,           // px, whole app
  codeSize: 12.5,         // px, code blocks and editor
  density: 'normal',      // normal | compact
  chatWidth: 'normal',    // normal | wide | full
  thinking: 'collapsed',  // collapsed | live (open while thinking) | expanded
  lineNumbers: true,
  wrapCode: false,
  codeMaxHeight: 520,     // px, 0 = unlimited
});

function load() {
  const phone = matchMedia('(max-width: 700px)').matches;
  const base = { ...DISPLAY_DEFAULTS, ...(phone ? { fontSize: 15, codeSize: 13, wrapCode: true } : {}) };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
}

export const display = load();

const prefersLight = matchMedia('(prefers-color-scheme: light)');

export function applyDisplay() {
  const r = document.documentElement;
  const theme = display.theme === 'auto' ? (prefersLight.matches ? 'light' : 'dark') : display.theme;
  r.dataset.theme = theme;
  r.dataset.density = display.density;
  r.style.setProperty('--fs', display.fontSize + 'px');
  r.style.setProperty('--code-fs', display.codeSize + 'px');
  r.style.setProperty('--chat-w', WIDTHS[display.chatWidth] || WIDTHS.normal);
  r.style.setProperty('--code-max-h', display.codeMaxHeight ? display.codeMaxHeight + 'px' : 'none');
  r.classList.toggle('no-lines', !display.lineNumbers);
  r.classList.toggle('wrap-code', !!display.wrapCode);
  const link = document.getElementById('hl-theme');
  if (link) link.href = HL + (theme === 'light' ? 'github.min.css' : 'github-dark.min.css');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#10141a');
}

export function setDisplay(patch) {
  Object.assign(display, patch);
  try { localStorage.setItem(KEY, JSON.stringify(display)); } catch { /* ignore */ }
  applyDisplay();
  emit('display');
}

export function resetDisplay() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  Object.assign(display, load());
  applyDisplay();
  emit('display');
}

prefersLight.addEventListener?.('change', () => { if (display.theme === 'auto') applyDisplay(); });
