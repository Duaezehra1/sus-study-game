import { getApps, initializeApp } from 'firebase/app'

// The extension only uses Firebase AI Logic on-device (ONLY_ON_DEVICE), which needs no network,
// so there's no App Check, Auth or Firestore here. Anything that needs the cloud is handed off
// to the Sus website, where App Check protects it.
if (getApps().length === 0) {
  initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  })
}
