import { initializeApp, type FirebaseOptions } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { browserSessionPersistence, initializeAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

// Values come from web/.env.local (copy .env.example and fill in from the Firebase console).
const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId)

export const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null

// Session persistence: every browser tab is its own anonymous player, and a refresh
// keeps you in the same seat (host stays host, players keep their card).
export const auth: Auth | null = firebaseApp
  ? initializeAuth(firebaseApp, { persistence: [browserSessionPersistence] })
  : null

export const db: Firestore | null = firebaseApp ? getFirestore(firebaseApp) : null

// App Check proves requests to Firebase AI Logic come from this app, not from someone
// who copied the API key. Localhost uses a registered debug token; the deployed site
// uses reCAPTCHA Enterprise.
const recaptchaSiteKey: string | undefined = import.meta.env.VITE_RECAPTCHA_SITE_KEY
const debugToken: string | undefined = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname)

if (firebaseApp && (recaptchaSiteKey || (isLocalhost && debugToken))) {
  if (isLocalhost && debugToken) {
    ;(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken
  }
  initializeAppCheck(firebaseApp, {
    // In debug mode the SDK exchanges the debug token instead of calling reCAPTCHA.
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey ?? 'debug-mode'),
    isTokenAutoRefreshEnabled: true,
  })
}
