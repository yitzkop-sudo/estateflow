import { apiGet, apiPost } from "./api";

/**
 * Client wrappers around the Provalta API (Netlify Function) that drive
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

export type ConnectTransfer = {
  id: string;
  amount: number; // cents
  currency: string;
  description: string;
  created: string | null;
};

export type ConnectPayout = {
  id: string;
  amount: number; // cents
  currency: string;
  status: string;
  arrival: string | null;
  created: string | null;
};

export type ConnectActivity = {
  balance: { available: number; pending: number; currency: string };
  payoutSchedule: { interval: string; delayDays: number | null };
  bank: { last4: string; bankName: string; currency: string } | null;
  transfers: ConnectTransfer[];
  payouts: ConnectPayout[];
};

/** Rent received, bank payouts and current balance — viewed in-app. */
export async function fetchConnectActivity(): Promise<ConnectActivity> {
  return apiGet<ConnectActivity>("/connect-activity");
}

/** Returns the hosted URL where the landlord completes Stripe onboarding. */
export async function startConnectOnboarding(): Promise<string> {
  const res = await apiPost<{ url: string }>("/create-connect-onboarding");
  return res.url;
}
