import { Alert, Linking } from "react-native";
import { apiGet } from "./api";

/**
 * Plan entitlements for the paid tiers:
 *   starter (1) < professional (2) < autosync (3)
 *
 * Excel exports and the tenant portal website require Professional+;
 * utility auto-sync requires Auto-Sync. The server enforces these too —
 * this client helper just gives fast, friendly gating in the UI.
 */

export type PlanId = "starter" | "professional" | "autosync";
export type PlanFeature = "exports" | "portal" | "autosync";

export interface PlanStatus {
  plan: PlanId | null;
  tier: number;
  active: boolean;
  features: { exports: boolean; portal: boolean; autosync: boolean };
  websiteUrl: string | null;
}

let cache: { status: PlanStatus; at: number } | null = null;

/** Current plan entitlements (cached for 60s; pass force=true to refetch). */
export async function getPlanStatus(force = false): Promise<PlanStatus> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.status;
  const status = await apiGet<PlanStatus>("/plan-status");
  cache = { status, at: Date.now() };
  return status;
}

/**
 * Gate a plan-gated feature. Returns true when allowed; otherwise shows an
 * upgrade prompt (with a link to the pricing section of the website).
 */
export async function requirePlanFeature(feature: PlanFeature, label: string): Promise<boolean> {
  try {
    const status = await getPlanStatus();
    if (status.features?.[feature]) return true;

    const websiteUrl = status.websiteUrl ? `${status.websiteUrl}/#pricing` : null;
    Alert.alert(
      "Upgrade required",
      `${label} is part of the Professional plan. Upgrade to unlock it.`,
      [
        { text: "Not now", style: "cancel" },
        ...(websiteUrl
          ? [{ text: "See plans", onPress: () => void Linking.openURL(websiteUrl) }]
          : []),
      ]
    );
    return false;
  } catch (err: any) {
    Alert.alert(
      "Couldn't verify your plan",
      err?.message ||
        "We couldn't confirm your subscription. Check your connection and try again."
    );
    return false;
  }
}
