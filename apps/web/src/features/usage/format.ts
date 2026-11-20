/** `—` when no turn ran; `<$0.01` below a cent; cents under $1,000, whole dollars from there. */
export function formatCost(usd: number, turns: number): string {
  if (turns === 0) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${(Math.round(usd * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCostEst(usd: number, turns: number): string {
  const cost = formatCost(usd, turns);
  return cost === "—" ? cost : `${cost} est.`;
}

/** A `YYYY-MM-DD` day as numbers, so no zone can shift it. */
export function parseDay(date: string): { y: number; m: number; d: number } {
  const [y = 0, m = 0, d = 0] = date.split("-").map(Number);
  return { y, m, d };
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
/** `Thu 20 Nov`. */
export function formatDayShort(date: string): string {
  const { y, m, d } = parseDay(date);
  const parts = Object.fromEntries(
    dayFormat.formatToParts(Date.UTC(y, m - 1, d)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** The smallest 1, 2 or 5 x 10^n that is at least `v` (1 for zero). */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * exp;
    if (candidate >= v * (1 - 1e-12)) return Number(candidate.toPrecision(12));
  }
  return 10 * exp;
}

export const RATE_LIMIT_WINDOW: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
};
