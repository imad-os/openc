// Firebase Authentication: Google + email/password.
import { firebaseConfig } from '../config.js';
import { loadFirebase } from './storage/cloud.js';

const OVERRIDE_KEY = 'oc2.firebaseConfig';
let fb = null;

/** Config from Settings (localStorage) wins over js/config.js. Returns null when not configured. */
export function getFirebaseConfig() {
  try {
    const o = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null');
    if (o?.apiKey && o?.projectId) return o;
  } catch { /* ignore */ }
  return firebaseConfig?.apiKey && firebaseConfig?.projectId ? firebaseConfig : null;
}
export const getFirebaseOverrideText = () => localStorage.getItem(OVERRIDE_KEY) || '';
export function setFirebaseOverride(obj) {
  if (obj) localStorage.setItem(OVERRIDE_KEY, JSON.stringify(obj));
  else localStorage.removeItem(OVERRIDE_KEY);
}

export const firebase = () => fb;

export async function initAuth(onUser) {
  const cfg = getFirebaseConfig();
  if (!cfg) return null;
  fb = await loadFirebase(cfg);
  fb.A.onAuthStateChanged(fb.auth, onUser);
  return fb;
}

export async function signInGoogle() {
  const provider = new fb.A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await fb.A.signInWithPopup(fb.auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
      return fb.A.signInWithRedirect(fb.auth, provider);
    }
    throw e;
  }
}
export const signInEmail = (email, pass) => fb.A.signInWithEmailAndPassword(fb.auth, email, pass);
export async function signUpEmail(email, pass) {
  const cred = await fb.A.createUserWithEmailAndPassword(fb.auth, email, pass);
  try { await fb.A.sendEmailVerification(cred.user); } catch { /* non-fatal */ }
  return cred;
}
export const resendVerification = () => fb.A.sendEmailVerification(fb.auth.currentUser);
export const resetPassword = email => fb.A.sendPasswordResetEmail(fb.auth, email);
export const signOut = () => fb.A.signOut(fb.auth);

const MESSAGES = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'No account with this email. Create one first.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/missing-password': 'Enter your password.',
  'auth/popup-closed-by-user': 'The sign-in window was closed.',
  'auth/cancelled-popup-request': 'The sign-in window was closed.',
  'auth/unauthorized-domain': 'This website is not authorized for sign-in. Add it in Firebase console → Authentication → Settings → Authorized domains.',
  'auth/operation-not-allowed': 'This sign-in method is disabled. Enable it in Firebase console → Authentication → Sign-in method.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection.',
};
export const authErrorText = e => MESSAGES[e?.code] || e?.message || String(e);
