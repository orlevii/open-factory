export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  // The thresholds compare the rounded figure, so 999,999 reads "1.0M" and 99,950 "100k"
  // (not "1000k" or "100.0k").
  if (Math.round(n / 1000) >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.round(n / 100) >= 1000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000).toFixed(1)}k`;
}
/** Binary units (1024), matching `MAX_UPLOAD_BYTES`. The number and unit are joined by a no-break
 *  space, so a size never wraps. A KB value that would round to 1024 KB reads as MB instead. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) {
    const kb = Math.round(n / 1024);
    if (kb < 1024) return `${kb} KB`;
  }
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Local reset time: `14:30` today, `Thu 09:10` within the next 6 days, else `27 Nov 09:10`. */
export function formatResetTime(until: Date, now: Date): string {
  const hhmm = `${pad(until.getHours())}:${pad(until.getMinutes())}`;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(until) - day(now)) / 86_400_000);
  if (days <= 0) return hhmm;
  if (days <= 6) return `${WEEKDAYS[until.getDay()]} ${hhmm}`;
  return `${until.getDate()} ${MONTHS[until.getMonth()]} ${hhmm}`;
}

/** Past time for a row (S6 UI design §4): `14:32` today, `Yesterday 14:32`, `27 Nov 09:10`, and
 *  `27 Nov 2025 09:10` for another year. Future times (clock skew) fall back to S5's format. */
export function formatInboxTime(at: Date, now: Date): string {
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days < 0) return formatResetTime(at, now);
  if (days === 0) return hhmm;
  if (days === 1) return `Yesterday ${hhmm}`;
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear()
    ? `${date} ${hhmm}`
    : `${date} ${at.getFullYear()} ${hhmm}`;
}

/** A past moment on a row (U3 §7.6 "last 19:32"): `19:32` today, `Mon 19:32` within the past week,
 *  else `27 Nov 19:32` (with the year when it differs). */
export function formatLastAt(at: Date, now: Date): string {
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return hhmm;
  if (days <= 6) return `${WEEKDAYS[at.getDay()]} ${hhmm}`;
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear()
    ? `${date} ${hhmm}`
    : `${date} ${at.getFullYear()} ${hhmm}`;
}

/** A local calendar day for a row note (S7 UI design §3): `19 Nov`, or `31 Dec 2025` in another year.
 *  Past or future alike: the note names the day, never the time. */
export function formatDay(at: Date, now: Date): string {
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date} ${at.getFullYear()}`;
}

/** A moment in a sentence (S7 UI design §1), local time with the preposition its output needs:
 *  "today at 14:32", "yesterday at 14:32", "on 19 Nov at 14:32", "on Sun at 14:32". Past moments
 *  use `formatInboxTime`, future ones `formatResetTime`. */
export function atPhrase(at: Date, now: Date): string {
  const text = at.getTime() <= now.getTime() ? formatInboxTime(at, now) : formatResetTime(at, now);
  const i = text.lastIndexOf(" ");
  const day = i < 0 ? "" : text.slice(0, i);
  const time = text.slice(i + 1);
  if (day === "") return `today at ${time}`;
  if (day === "Yesterday") return `yesterday at ${time}`;
  return `on ${day} at ${time}`;
}

/** The one duration format (U3 §5.4): "42s", "1m 09s", "1h 03m". The smaller unit is padded after a
 *  larger one, so the width only changes at unit boundaries. */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(total % 60)}s`;
  return `${total}s`;
}
