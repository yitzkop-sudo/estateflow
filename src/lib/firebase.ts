import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  CACHE_SIZE_UNLIMITED,
  Firestore,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
} from "firebase/firestore";
import { Platform } from "react-native";
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

export const auth = getAuth(app);

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