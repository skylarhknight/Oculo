import { getApps, initializeApp } from "firebase/app";
import type { FirebaseApp, FirebaseOptions } from "firebase/app";

/**
 * Firebase web configuration is read from build-time environment variables.
 * These are public identifiers, not secrets. When the required values are
 * missing, accounts and cloud sync are disabled and the app stays local-only.
 */
export function firebaseConfigFromEnv(): FirebaseOptions | null {
  const apiKey: string | undefined = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId: string | undefined = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId: string | undefined = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !projectId || !appId) return null;

  const authDomain: string | undefined = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const messagingSenderId: string | undefined = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
  const storageBucket: string | undefined = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
  return {
    apiKey,
    projectId,
    appId,
    ...(authDomain ? { authDomain } : {}),
    ...(messagingSenderId ? { messagingSenderId } : {}),
    ...(storageBucket ? { storageBucket } : {}),
  };
}

let cachedApp: FirebaseApp | null | undefined;

export function getFirebaseApp(): FirebaseApp | null {
  if (cachedApp !== undefined) return cachedApp;
  const config = firebaseConfigFromEnv();
  cachedApp = config === null ? null : (getApps()[0] ?? initializeApp(config));
  return cachedApp;
}
