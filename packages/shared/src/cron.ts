import { Cron } from "croner";

// The only module that imports croner. The server and the web both go through here, so the
// factory has one validator and one version of the occurrence math.

const FIVE_FIELDS = "Use 5 fields: minute hour day-of-month month day-of-week.";
const TOKENS = "Only numbers, *, ranges, lists, steps and names are allowed.";
const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;
const ATOM = "(?:\\*|[0-9]+|[a-z]{3})(?:-(?:[0-9]+|[a-z]{3}))?(?:\\/[0-9]+)?";
const FIELD = new RegExp(`^${ATOM}(?:,${ATOM})*$`, "i");
const NEVER = "This pattern never runs.";
const MS_MINUTE = 60_000;

function cronOf(expr: string, zone: string): Cron {
  return new Cron(expr.trim(), { timezone: zone, paused: true });
}

/** null = valid; otherwise one sentence. Plain five-field Vixie cron only. */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FIVE_FIELDS;
  const bad = parts.findIndex((p) => !FIELD.test(p));
  if (bad >= 0) return TOKENS;
  const range = (i: number, p: string) => rangeError(FIELD_NAMES[i] as string, p);
  for (const [i, p] of parts.entries()) {
    const e = range(i, p);
    if (e) return e;
  }
  try {
    cronOf(expr, "UTC");
  } catch (e) {
    return croneSentence(e);
  }
  return nextRun(expr, "UTC", new Date()) ? null : NEVER;
}

const LIMITS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function rangeError(name: string, part: string): string | null {
  const idx = FIELD_NAMES.indexOf(name as (typeof FIELD_NAMES)[number]);
  const [lo, hi] = LIMITS[idx] as [number, number];
  for (const atom of part.split(",")) {
    for (const n of atom.split("/")[0]?.split("-") ?? []) {
      if (/^[0-9]+$/.test(n) && (Number(n) < lo || Number(n) > hi))
        return `Invalid value for ${name}: ${n}. Use ${lo} to ${hi}.`;
    }
    const step = atom.split("/")[1];
    if (step !== undefined && Number(step) < 1) return `Invalid step for ${name}: ${step}.`;
  }
  return null;
}

function croneSentence(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const text = raw.replace(/^CronPattern:\s*/i, "").trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function isValidZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The server's resolved zone, or UTC when the runtime cannot tell. */
export function factoryZoneDefault(): string {
  const z = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return z && isValidZone(z) ? z : "UTC";
}

/** The first occurrence strictly after `after`. */
export function nextRun(expr: string, zone: string, after: Date): Date | null {
  return cronOf(expr, zone).nextRun(after);
}

export function nextRuns(expr: string, zone: string, after: Date, n: number): Date[] {
  return cronOf(expr, zone).nextRuns(n, after);
}

/** The latest occurrence at or before `now` (an occurrence exactly at `now` counts; croner truncates its reference to whole seconds, so it is `now + 1 s`). */
export function latestAtOrBefore(expr: string, zone: string, now: Date): Date | null {
  return cronOf(expr, zone).previousRuns(1, new Date(now.getTime() + 1000))[0] ?? null;
}

/** Occurrences in [from, to], at most `cap`. */
export function countRuns(expr: string, zone: string, from: Date, to: Date, cap = 1000): number {
  const c = cronOf(expr, zone);
  let n = 0;
  let at = c.nextRun(new Date(from.getTime() - 1));
  while (at && at.getTime() <= to.getTime() && n < cap) {
    n++;
    at = c.nextRun(at);
  }
  return n;
}

/** The smallest gap in minutes between consecutive occurrences among the next `n` after `after`. */
export function minGapMinutes(expr: string, zone: string, after: Date, n = 10): number {
  const runs = nextRuns(expr, zone, after, n);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i++)
    min = Math.min(
      min,
      ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / MS_MINUTE,
    );
  return min;
}

function offsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: zone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(at));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m?.[1]) return 0;
  const ms = (Number(m[2]) * 60 + Number(m[3])) * MS_MINUTE;
  return m[1] === "-" ? -ms : ms;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const WITH_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** An ISO 8601 date-time: with an offset it is that instant; without, it is read in `zone`. */
export function parseAt(at: string, zone: string): Date | null {
  const s = at.trim();
  if (WITH_OFFSET.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = WALL.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const check = new Date(guess);
  if (
    Number.isNaN(guess) ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  )
    return null;
  const o1 = offsetMs(zone, guess);
  const t = guess - o1;
  const o2 = offsetMs(zone, t);
  return new Date(o2 === o1 ? t : guess - o2);
}

/** "2026-11-23T09:00:00+01:00": the instant in `zone`, with that zone's offset at that instant. */
export function formatOffsetIso(at: Date, zone: string): string {
  const off = offsetMs(zone, at.getTime());
  const wall = new Date(at.getTime() + off);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off) / MS_MINUTE;
  return (
    `${p(wall.getUTCFullYear(), 4)}-${p(wall.getUTCMonth() + 1)}-${p(wall.getUTCDate())}` +
    `T${p(wall.getUTCHours())}:${p(wall.getUTCMinutes())}:${p(wall.getUTCSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}
