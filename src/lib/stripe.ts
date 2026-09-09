import { apiGet, apiPost } from "./api";

/**
 * Client wrappers around the EstateFlow API (Netlify Function) that drive
 * Stripe. All Stripe secrets stay server-side.
 */

export type ConnectStatus = {
  connected: boolean;
  payoutsEnabled: boolean;
  accountId: string | null;
};

/** Whether this landlord has connected (and finished) Stripe payout setup. */
export async function fetchConnectStatus(): Promise<ConnectStatus> {
  return apiGet<ConnectStatus>("/connect-status");
}

/** Returns the hosted URL where the landlord completes Stripe onboarding. */
export async function startConnectOnboarding(): Promise<string> {
  const res = await apiPost<{ url: string }>("/create-connect-onboarding");
  return res.url;
}
