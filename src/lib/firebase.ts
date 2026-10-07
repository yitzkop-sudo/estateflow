import { initializeApp } from "firebase/app";
import {
  Auth,
  getAuth,
  initializeAuth,
  type Persistence,
} from "firebase/auth";
import {
  CACHE_SIZE_UNLIMITED,
  Firestore,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
} from "firebase/firestore";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: "estateflow-827fc.firebaseapp.com",
  projectId: "estateflow-827fc",
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

// Web uses default (IndexedDB) persistence. On native the JS SDK only keeps
// auth in memory by default — AsyncStorage persistence keeps users (including
// Google sign-ins) signed in across app restarts.
//
// Note: getReactNativePersistence only exists in firebase/auth's React Native
// entrypoint (resolved by Metro on-device, invisible to TypeScript), so it is
// read defensively at runtime instead of imported.
const getReactNativePersistence = (require("firebase/auth") as {
  getReactNativePersistence?: (
    storage: typeof AsyncStorage
  ) => Persistence;
})?.getReactNativePersistence;

let auth: Auth;
try {
  if (Platform.OS !== "web" && getReactNativePersistence) {
    auth = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } else {
    auth = getAuth(app);
  }
} catch {
  // Already initialized (e.g. Fast Refresh) — reuse the existing instance.
  auth = getAuth(app);
}

export { auth };

// Enable offline persistence:
// - Web: uses IndexedDB via persistentLocalCache (memory cache is default on web)
// - Android/iOS: native SDK handles persistence automatically; getFirestore is sufficient
let db: Firestore;
try {
  if (Platform.OS === "web") {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
    });
  } else {
    db = getFirestore(app);
  }
} catch {
  // initializeFirestore throws if already initialized — safe to use getFirestore
  db = getFirestore(app);
}

export { db };
export const storage = getStorage(app);