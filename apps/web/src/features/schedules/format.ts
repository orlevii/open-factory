/**
 * The one formatter for a schedule time (UI design §1): weekday, day, month, 24h time in the schedule's zone, the year
 * only when it isn't the current one (in that zone). The zone's IANA name is returned apart so the caller can mute it.
 */
export function formatScheduleTime(
  at: Date,
  zone: string,
  now: Date,
): { text: string; zone: string; iso: string } {
  const parts = (d: Date, year: boolean) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "short",
        day: "numeric",
        month: "short",
        ...(year ? { year: "numeric" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
  const yearOf = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric" }).format(d);
  const p = parts(at, yearOf(at) !== yearOf(now));
  const date = `${p.weekday} ${p.day} ${p.month}${p.year ? ` ${p.year}` : ""}`;
  return { text: `${date} ${p.hour}:${p.minute}`, zone, iso: at.toISOString() };
}

/** The viewer's own wall time for a `<time>` title: the clock, with the date when it differs from the schedule's. */
export function viewerTime(at: Date, zone: string, now: Date): string {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = (z: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: z,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  const day = (z: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: z, day: "numeric", month: "short" }).format(at);
  void now;
  return day(viewerZone) === day(zone)
    ? clock(viewerZone)
    : `${day(viewerZone)} ${clock(viewerZone)}`;
}

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
