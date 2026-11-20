/** `—` when no turn ran; `<$0.01` below a cent; cents under $1,000, whole dollars from there. The
 *  amount is rounded to cents first, so $999.996 reads "$1,000" rather than "$1,000.00". */
export function formatCost(usd: number, turns: number): string {
  if (turns === 0) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  // toPrecision drops float noise first, so a half cent (999.995 is 999.99499... as a double) rounds up.
  const cents = Math.round(Number((usd * 100).toPrecision(12))) / 100;
  if (cents >= 1000) return `$${Math.round(cents).toLocaleString("en-US")}`;
  return `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  timeZone: "UTC",
});
/** Fixed, so every month is three letters (en-GB ICU writes September as "Sept"). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Thu 20 Nov`. */
export function formatDayShort(date: string): string {
  const { y, m, d } = parseDay(date);
  const parts = Object.fromEntries(
    dayFormat.formatToParts(Date.UTC(y, m - 1, d)).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${MONTHS[m - 1]}`;
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
