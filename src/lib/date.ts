export type DueDay = number | "last";

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function formatDueDay(d: DueDay) {
  return d === "last" ? "Last" : ordinal(d);
}

export function computeNextDueDate(d: DueDay, from = new Date()): Date {
  const year = from.getFullYear();
  const month = from.getMonth();

  const getLastDay = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

  const buildDate = (y: number, m: number, day: number) => {
    const max = getLastDay(y, m);
    const d = Math.min(day, max);
    return new Date(y, m, d, 12, 0, 0, 0);
  };

  if (d === "last") {
    const candidate = buildDate(year, month, getLastDay(year, month));
    if (candidate >= from) return candidate;
    // next month
    const nextMonth = month + 1;
    const y = year + Math.floor(nextMonth / 12);
    const m = nextMonth % 12;
    return buildDate(y, m, getLastDay(y, m));
  }

  // numeric day
  const candidate = buildDate(year, month, d);
  if (candidate >= from) return candidate;
  // next month
  const nextMonth = month + 1;
  const y = year + Math.floor(nextMonth / 12);
  const m = nextMonth % 12;
  return buildDate(y, m, d);
}

// simple CLI test runner (not a full test framework)
if (typeof require !== 'undefined' && (require as any).main === module) {
  const now = new Date();
  console.log('Now:', now.toISOString());
  console.log('Next for 15:', computeNextDueDate(15, now).toISOString());
  console.log('Next for last:', computeNextDueDate('last', now).toISOString());
}

export default {
  computeNextDueDate,
  formatDueDay,
};
