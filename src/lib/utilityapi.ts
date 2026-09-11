import { apiGet, apiPost } from "./api";

/**
 * Paid "auto utility sync" — all UtilityAPI calls happen server-side in the
 * Netlify API function, so the UtilityAPI token never lives in the app. On the
 * free tier, users enter utilities manually instead.
 */

export type UtilitySubStatus = {
  active: boolean;
  plan: string | null;
  currentPeriodEnd: string | null;
  portalUrl: string | null;
  meterLimit: number;
  linkedMeters: number;
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
export async function openAuthForm(utilityUid?: string): Promise<UtilityAuthForm> {
  return apiPost<UtilityAuthForm>(
    "/create-utility-auth-form",
    utilityUid ? { utilityUid } : undefined
  );
}

/** Complete an authorization and return the linked bill data. */
export async function linkUtilityToProperty(
  formUid: string
): Promise<LinkedUtilityData> {
  return apiPost<LinkedUtilityData>("/link-utility-auto", { formUid });
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

/** Start subscribing (returns a Stripe Checkout / portal URL to open). */
export async function startUtilitySubscription(): Promise<{
  url: string;
  alreadyActive: boolean;
}> {
  return apiPost<{ url: string; alreadyActive: boolean }>(
    "/create-utility-subscription"
  );
}
