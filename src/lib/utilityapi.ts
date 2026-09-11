import { apiGet, apiPost } from "./api";

/**
 * Paid "auto utility sync" — all UtilityAPI calls happen server-side in the
 * Netlify API function, so the UtilityAPI token never lives in the app. On the
 * free tier, users enter utilities manually instead.
 */

export interface UtilityKeyStatus {
  active: boolean;
  legacy?: boolean;
  currentPeriodEnd: string | null;
}

// Billing is per utility: one $20/mo subscription per utility key. Paying
// for Electric never covers Water — each key needs its own subscription.
export type UtilitySubStatus = {
  active: boolean;
  plan: string | null;
  currentPeriodEnd: string | null;
  portalUrl: string | null;
  meterLimit: number;
  linkedMeters: number;
  subscriptions?: Record<string, UtilityKeyStatus>;
  activeKeys?: string[];
};

export interface LinkedUtilityData {
  amount: string;
  provider: string;
  dueDay: number;
  meterUid: string;
}

export interface UtilityAuthForm {
  formUid: string;
  url: string;
}

export interface SupportedUtility {
  uid: string;
  name: string;
}

/** Whether a paid plan is configured server-side (always true for us). */
export function isProviderConfigured() {
  // The capability now lives server-side. Return true so the feature UI shows;
  // entitlement is enforced by the API.
  return true;
}

/** Provider catalog for the in-app picker. No subscription needed. */
export async function getSupportedUtilities(): Promise<SupportedUtility[]> {
  return apiGet<SupportedUtility[]>("/supported-utilities");
}

/**
 * Create the UtilityAPI authorization form; returns a browser URL to open.
 * When a provider uid is given, the hosted page opens straight on that
 * provider's login.
 */
export async function openAuthForm(
  utilityUid?: string,
  utilityKey?: string
): Promise<UtilityAuthForm> {
  const body: Record<string, string> = {};
  if (utilityUid) body.utilityUid = utilityUid;
  if (utilityKey) body.utilityKey = utilityKey;
  return apiPost<UtilityAuthForm>(
    "/create-utility-auth-form",
    Object.keys(body).length ? body : undefined
  );
}

/** Complete an authorization and return the linked bill data. */
export async function linkUtilityToProperty(
  formUid: string,
  utilityKey?: string
): Promise<LinkedUtilityData> {
  return apiPost<LinkedUtilityData>("/link-utility-auto", {
    formUid,
    ...(utilityKey ? { utilityKey } : {}),
  });
}

/** Refresh an already-linked meter and return its latest bill data. */
export async function refreshUtilityForProperty(
  meterUid: string
): Promise<Omit<LinkedUtilityData, "meterUid">> {
  return apiPost<Omit<LinkedUtilityData, "meterUid">>("/refresh-utility-auto", {
    meterUid,
  });
}

/** Current auto-sync subscription status + link to the Stripe billing portal. */
export async function getUtilitySubscriptionStatus(): Promise<UtilitySubStatus> {
  return apiGet<UtilitySubStatus>("/utility-subscription-status");
}

export interface AuthFormStatus {
  completed: boolean;
  meterCount: number;
}

/** Has the provider sign-in for this auth form completed yet? (for polling) */
export async function getAuthFormStatus(formUid: string): Promise<AuthFormStatus> {
  return apiGet<AuthFormStatus>(`/auth-form-status?formUid=${encodeURIComponent(formUid)}`);
}

/**
 * Start subscribing ONE utility (returns a Stripe Checkout / portal URL).
 * Every connect pays — a utilityKey is required so the subscription is
 * tagged to the right record. Already covered → billing portal instead.
 */
export async function startUtilitySubscription(
  utilityKey: string,
  forceNew?: boolean
): Promise<{
  url: string;
  alreadyActive: boolean;
}> {
  return apiPost<{ url: string; alreadyActive: boolean }>(
    "/create-utility-subscription",
    forceNew ? { utilityKey, forceNew: true } : { utilityKey }
  );
}

/**
 * Confirm a just-completed Stripe Checkout without waiting for webhooks.
 * Activates the entitlement from Stripe directly and reports if THIS
 * utility is covered yet.
 */
export async function confirmUtilitySubscription(
  sessionId?: string,
  utilityKey?: string
): Promise<{ active: boolean; alreadyActive?: boolean; detail?: string }> {
  const body: Record<string, string> = {};
  if (sessionId) body.sessionId = sessionId;
  if (utilityKey) body.utilityKey = utilityKey;
  return apiPost<{ active: boolean; alreadyActive?: boolean; detail?: string }>(
    "/confirm-utility-subscription",
    Object.keys(body).length ? body : undefined
  );
}
