// Sign-in screen: Google, email/password (sign in / create account / reset), or local mode.
import { $ } from '../util/dom.js';
import { show } from './views.js';
import { signInGoogle, signInEmail, signUpEmail, resetPassword, authErrorText } from '../core/auth.js';

let mode = 'signin';

function message(text, kind = '') {
  const el = $('#a-msg');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'msgbox ' + kind;
}

function setMode(m) {
  mode = m;
  $('#a-submit').textContent = m === 'signin' ? 'Sign in' : 'Create account';
  $('#a-toggle').textContent = m === 'signin' ? 'Create an account' : 'I already have an account';
  $('#a-pass').autocomplete = m === 'signin' ? 'current-password' : 'new-password';
  message('');
}

function busy(on) { document.querySelectorAll('#a-card button').forEach(b => { b.disabled = on; }); }

async function attempt(fn, okText) {
  busy(true);
  message('');
  try { await fn(); if (okText) message(okText); }
  catch (e) { message(authErrorText(e), 'err'); }
  finally { busy(false); }
}

export function initAuthUI({ onLocal }) {
  $('#a-google').addEventListener('click', () => attempt(signInGoogle));
  $('#a-form').addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
    attempt(() => (mode === 'signin' ? signInEmail(email, pass) : signUpEmail(email, pass)),
      mode === 'signup' ? 'Account created. A verification email is on its way.' : '');
  });
  $('#a-toggle').addEventListener('click', e => { e.preventDefault(); setMode(mode === 'signin' ? 'signup' : 'signin'); });
  $('#a-reset').addEventListener('click', e => {
    e.preventDefault();
    const email = $('#a-email').value.trim();
    if (!email) return message('Type your email above, then click "Forgot password?" again.', 'err');
    attempt(() => resetPassword(email), `Password reset email sent to ${email}.`);
  });
  $('#a-local').addEventListener('click', () => onLocal());
}

export function showAuth({ loading = false } = {}) {
  show('auth');
  $('#a-loading').hidden = !loading;
  $('#a-card').hidden = loading;
}
