export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000).toFixed(1)}k`;
}
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(n / 1000)} KB`;
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
