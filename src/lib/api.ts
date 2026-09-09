import { auth } from "./firebase";

/**
 * Thin client for the EstateFlow API (Netlify Function).
 *
 * The server verifies the signed-in user with the Firebase ID token we send in
 * the `Authorization: Bearer` header, replicating the auth that Firebase
 * Callable Functions used to provide. All Stripe/UtilityAPI secrets live
 * server-side on Netlify — never in the app.
 */

const API_BASE = process.env.EXPO_PUBLIC_API_URL || "";

function apiBase() {
  if (!API_BASE) {
    throw new Error(
      "API is not configured. Set EXPO_PUBLIC_API_URL in .env to your Netlify function URL and rebuild."
    );
  }
  return API_BASE.replace(/\/+$/, "");
}

async function idToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("UNAUTHENTICATED: Sign in to continue.");
  return user.getIdToken();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await idToken();
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!res.ok) {
    const msg = body?.message || body?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

/** GET a JSON endpoint, authenticating with the signed-in user's ID token. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

/** POST a JSON endpoint, authenticating with the signed-in user's ID token. */
export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
