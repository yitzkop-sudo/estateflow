/**
 * One-shot handoff for a provider link completed on the Connect screen.
 *
 * The Add/Edit Property form holds utilities in local state, so navigating to
 * a separate connect screen would lose in-progress form data if we passed the
 * result through route params. Instead the Connect screen stashes the linked
 * bill here, goes back, and Add Property consumes it on focus.
 */

export type PendingUtilityLink = {
  key: string;
  amount: string;
  provider: string;
  dueDay: number | "last";
  meterUid: string;
  notify?: boolean;
};

let pending: PendingUtilityLink | null = null;

export function setPendingUtilityLink(link: PendingUtilityLink) {
  pending = link;
}

export function consumePendingUtilityLink(): PendingUtilityLink | null {
  const link = pending;
  pending = null;
  return link;
}
