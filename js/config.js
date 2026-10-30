// Firebase web app config — enables Google / email sign-in and Firestore sync.
// These values are public identifiers, not secrets: data is protected by firestore.rules
// (each signed-in user can only access /users/{their uid}/…).
// To run without an account system, set apiKey to '' (local-only mode).
// A different config can also be pasted at runtime in Settings → Cloud sync.
export const firebaseConfig = {
  apiKey: 'AIzaSyBHc4DWNqzVDAVCVYfsb9vdfLuvK6OQzO4',
  authDomain: 'agents-df3d3.firebaseapp.com',
  projectId: 'agents-df3d3',
  storageBucket: 'agents-df3d3.firebasestorage.app',
  messagingSenderId: '964997613645',
  appId: '1:964997613645:web:10cd3094ffc3a936e77404',
};
