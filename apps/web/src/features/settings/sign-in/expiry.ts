export type ExpiryState =
  | { tone: "none" }
  | { tone: "muted"; text: string }
  | { tone: "warning" | "crimson"; text: string; needsSignIn: true };

const DAY_MS = 86_400_000;
const WARN_DAYS = 14;

type Kind = "month" | "date" | "day";
const OPTIONS: Record<Kind, Intl.DateTimeFormatOptions> = {
  month: { month: "short", year: "numeric" },
  date: { day: "numeric", month: "short", year: "numeric" },
  // en-CA gives YYYY-MM-DD, which makes a calendar-day difference exact.
  day: { year: "numeric", month: "2-digit", day: "2-digit" },
};

// Built once per locale, zone and kind, never per call or per render.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: Kind, locale: string | undefined, timeZone: string | undefined) {
  const key = `${locale}|${timeZone}|${kind}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(kind === "day" ? "en-CA" : locale, {
      ...OPTIONS[kind],
      ...(timeZone ? { timeZone } : {}),
    });
    formatters.set(key, f);
  }
  return f;
}

/** The calendar date in the zone, as a UTC midnight, so two of them differ by whole days. */
function calendarDay(d: Date, timeZone: string | undefined): number {
  return Date.parse(`${formatter("day", undefined, timeZone).format(d)}T00:00:00Z`);
}

/** A credential's expiry line (spec §8.4): muted beyond 14 days, a warning up to then, crimson once past. */
export function expiryState(
  expiresAt: string | null,
  now: Date,
  locale?: string,
  timeZone?: string,
): ExpiryState {
  if (expiresAt === null) return { tone: "none" };
  const at = new Date(expiresAt);
  const delta = at.getTime() - now.getTime();
  if (delta <= 0)
    return {
      tone: "crimson",
      text: `Expired ${formatter("date", locale, timeZone).format(at)}`,
      needsSignIn: true,
    };
  if (delta <= WARN_DAYS * DAY_MS) {
    const days = Math.min(
      WARN_DAYS,
      Math.round((calendarDay(at, timeZone) - calendarDay(now, timeZone)) / DAY_MS),
    );
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return { tone: "warning", text: `Expires ${when}`, needsSignIn: true };
  }
  return { tone: "muted", text: `Expires ${formatter("month", locale, timeZone).format(at)}` };
}
