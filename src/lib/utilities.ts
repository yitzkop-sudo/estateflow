/**
 * Shared utility-meter model.
 *
 * Each utility key (Electric, Water, …) keeps its legacy top-level fields as
 * "meter 1" and may carry extra meters in `meters[]`. Every reader (totals,
 * reminders, exports) must go through the helpers below so extra meters are
 * never silently dropped.
 */

export type UtilityDueDay = number | "last";

export interface UtilityMeterEntry {
  meterUid?: string;
  label?: string;
  amount: string;
  provider: string;
  dueDay: UtilityDueDay;
  auto?: boolean;
  notify?: boolean;
}

/** Alias used across the app for an extra meter on a utility. */
export type UtilityMeter = UtilityMeterEntry;

export interface UtilityItemLike {
  amount?: any;
  provider?: any;
  dueDay?: any;
  meterUid?: string;
  auto?: boolean;
  notify?: boolean;
  meters?: any;
}

/** Every meter on the utility: legacy primary first, then extras. */
export function utilityMeters(item?: UtilityItemLike | null): UtilityMeterEntry[] {
  if (!item || typeof item !== "object") return [];
  const out: UtilityMeterEntry[] = [];
  const hasPrimary =
    (item.amount !== undefined && String(item.amount).trim() !== "") ||
    (item.provider !== undefined && String(item.provider).trim() !== "") ||
    item.meterUid;
  if (hasPrimary) {
    out.push({
      meterUid: item.meterUid,
      amount: String(item.amount ?? ""),
      provider: String(item.provider ?? ""),
      dueDay: (item.dueDay as UtilityDueDay) ?? 15,
      auto: item.auto,
      notify: item.notify,
    });
  }
  if (Array.isArray(item.meters)) {
    for (const m of item.meters) {
      if (!m || typeof m !== "object") continue;
      out.push({
        meterUid: typeof m.meterUid === "string" ? m.meterUid : undefined,
        label: typeof m.label === "string" ? m.label : undefined,
        amount: String(m.amount ?? ""),
        provider: String(m.provider ?? ""),
        dueDay: (m.dueDay as UtilityDueDay) ?? 15,
        auto: m.auto,
        notify: m.notify,
      });
    }
  }
  return out;
}

/** Summed monthly amount across all meters on the utility. */
export function utilityTotal(item?: UtilityItemLike | null): number {
  return utilityMeters(item).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);
}

/** Summed monthly amount across a whole utilities map. */
export function utilitiesTotal(utilities?: Record<string, UtilityItemLike> | null): number {
  if (!utilities) return 0;
  return Object.values(utilities).reduce((s, u) => s + utilityTotal(u), 0);
}

/** Meters on the utility that have a linked provider meter. */
export function linkedMeterUids(item?: UtilityItemLike | null): string[] {
  const seen = new Set<string>();
  for (const m of utilityMeters(item)) {
    if (m.meterUid) seen.add(String(m.meterUid));
  }
  return [...seen];
}
