import { Platform, TurboModuleRegistry } from "react-native";
import { GoogleAuthProvider, signInWithCredential, signOut } from "firebase/auth";
import { auth } from "./firebase";

/** Thrown when the user backs out of the Google account picker. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "GoogleSignInCancelled";
  }
}

type GoogleSigninModule =
  typeof import("@react-native-google-signin/google-signin");

let cachedModule: GoogleSigninModule | null = null;

const NATIVE_MODULE_NAME = "RNGoogleSignin";

export const NATIVE_BUILD_REQUIRED_MESSAGE =
  "Native Google sign-in isn't part of this build. Rebuild your dev client " +
  "(eas build --profile development, then start it with npx expo start --dev-client). " +
  "Expo Go does not support native Google sign-in.";

/**
 * Non-enforcing probe for the native module. Unlike require()-ing the JS
 * package (whose eager TurboModule lookup redboxes in dev even when caught),
 * this safely returns false on Expo Go / stale builds.
 */
export function isNativeGoogleSignInAvailable(): boolean {
  if (Platform.OS === "web") return true;
  try {
    return TurboModuleRegistry.get(NATIVE_MODULE_NAME) != null;
  } catch {
    return false;
  }
}

/**
 * The native Google module is loaded lazily (not imported at file top) so
 * the app still boots inside Expo Go or a dev build that predates the
 * install — both lack the RNGoogleSignin TurboModule and would otherwise
 * crash on startup with an Invariant Violation.
 */
function loadNativeModule(): GoogleSigninModule {
  if (!isNativeGoogleSignInAvailable()) {
    throw new Error(NATIVE_BUILD_REQUIRED_MESSAGE);
  }
  if (cachedModule) return cachedModule;
  let mod: GoogleSigninModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@react-native-google-signin/google-signin");
  } catch {
    throw new Error(NATIVE_BUILD_REQUIRED_MESSAGE);
  }
  cachedModule = mod;
  return mod;
}

function isMissingNativeModule(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  return msg.includes("RNGoogleSignin") || msg.includes("TurboModuleRegistry");
}

let configured = false;

function ensureConfigured(GoogleSignin: GoogleSigninModule["GoogleSignin"]) {
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  if (!webClientId) {
    throw new Error(
      "Google sign-in is not configured yet. Add EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to your .env (Firebase Console → Project settings → General → Web API / OAuth client IDs) and rebuild the app."
    );
  }
  if (!configured) {
    GoogleSignin.configure({
      webClientId,
      // iOS falls back to GoogleService-Info.plist when omitted.
      ...(iosClientId ? { iosClientId } : {}),
      offlineAccess: false,
    });
    configured = true;
  }
}

/**
 * Native (iOS/Android) Google sign-in via the system account picker,
 * exchanging the Google ID token for a Firebase credential.
 * Web keeps using signInWithPopup (see login.tsx).
 */
export async function signInWithGoogleNative(): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error("Use the web Google sign-in flow on web.");
  }
  const { GoogleSignin, isErrorWithCode, statusCodes } = loadNativeModule();
  ensureConfigured(GoogleSignin);

  try {
    if (Platform.OS === "android") {
      await GoogleSignin.hasPlayServices({
        showPlayServicesUpdateDialog: true,
      });
    }

    let idToken: string | null = null;
    try {
      const response = await GoogleSignin.signIn();
      if (response.type === "cancelled") {
        throw new GoogleSignInCancelled();
      }
      idToken = response.data.idToken;
      if (!idToken) {
        // Rare: account selected but no ID token — refresh tokens and retry.
        const tokens = await GoogleSignin.getTokens();
        idToken = tokens.idToken ?? null;
      }
    } catch (err: any) {
      if (
        err instanceof GoogleSignInCancelled ||
        (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED)
      ) {
        throw new GoogleSignInCancelled();
      }
      throw err;
    }

    if (!idToken) {
      throw new Error("Google sign-in did not return an ID token. Please try again.");
    }

    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  } catch (err: any) {
    if (isMissingNativeModule(err)) {
      throw new Error(NATIVE_BUILD_REQUIRED_MESSAGE);
    }
    throw err;
  }
}

/**
 * Full sign-out: clears the Firebase session AND the native Google session.
 * Without the latter, the next Google tap would silently re-use the previous
 * account with no chance to switch. Best-effort — never throws.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await signOut(auth);
  } catch {
    // ignore — still try to clear the native session below
  }
  if (Platform.OS !== "web") {
    try {
      loadNativeModule().GoogleSignin.signOut();
    } catch {
      // e.g. running in Expo Go / stale build — nothing to clear
    }
  }
}
