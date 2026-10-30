// Finish / error / attention chimes (Web Audio, no files) + desktop notifications.

let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Browsers only allow audio after a user gesture; call this from one (e.g. Send). */
export function unlockAudio() { try { audio(); } catch { /* ignore */ } }

// [frequency Hz, start s, duration s]
const TUNES = {
  done: [[523.25, 0, 0.18], [659.25, 0.11, 0.18], [783.99, 0.22, 0.38]],
  error: [[392.0, 0, 0.22], [311.13, 0.2, 0.42]],
  attention: [[880, 0, 0.12], [1046.5, 0.16, 0.16]],
};

export function chime(kind = 'done', volume = 0.6) {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  const master = c.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.35;
  master.connect(c.destination);
  for (const [freq, at, dur] of TUNES[kind] || TUNES.done) {
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0 + at);
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(1, t0 + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(g).connect(master);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}

let baseTitle = document.title, flagged = false;
function flagTitle(prefix) {
  if (!document.hidden) return;
  if (!flagged) baseTitle = document.title;
  flagged = true;
  document.title = prefix + ' ' + baseTitle;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && flagged) { document.title = baseTitle; flagged = false; }
});

export async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** kind: 'done' | 'error' | 'attention' */
export function notify(kind, title, body, settings) {
  if (settings?.sound) chime(kind, settings.volume ?? 0.6);
  flagTitle(kind === 'error' ? '⚠' : kind === 'attention' ? '●' : '✓');
  if (settings?.desktopNotify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body: String(body || '').slice(0, 200), tag: 'ollama-code' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers need a service worker */ }
  }
}
