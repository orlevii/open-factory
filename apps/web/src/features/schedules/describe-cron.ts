export const REPEATS_PRESETS: readonly { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
];

export function presetOf(cron: string): string | undefined {
  const normalized = cron.trim().split(/\s+/).join(" ");
  return REPEATS_PRESETS.find((p) => p.cron === normalized)?.label;
}

const MINUTE_STEPS = new Set([2, 3, 4, 5, 6, 10, 12, 15, 20, 30]);
const HOUR_STEPS = new Set([2, 3, 4, 6, 8, 12]);
const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

const pad = (n: number) => String(n).padStart(2, "0");

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function weekdays(field: string): string | undefined {
  if (field === "1-5") return "Weekdays";
  if (!/^[0-7](,[0-7])*$/.test(field)) return undefined;
  const days = field.split(",").map((d) => Number(d) % 7);
  if (days.some((d, i) => i > 0 && d <= (days[i - 1] as number))) return undefined;
  if (days.length > 3) return undefined;
  return joinNames(days.map((d) => DAY_NAMES[d] as string));
}

export function describeCron(cron: string): string | undefined {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  if (mon !== "*") return undefined;

  if (hour === "*" && dom === "*" && dow === "*") {
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) {
      const n = Number(step[1]);
      return MINUTE_STEPS.has(n) ? `Every ${n} minutes` : undefined;
    }
    if (/^\d{1,2}$/.test(min) && Number(min) < 60) {
      return Number(min) === 0 ? "Every hour" : `Every hour at :${pad(Number(min))}`;
    }
    return undefined;
  }

  if (min === "0" && dom === "*" && dow === "*") {
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step) {
      const n = Number(step[1]);
      return HOUR_STEPS.has(n) ? `Every ${n} hours` : undefined;
    }
  }

  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return undefined;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return undefined;
  const time = `${pad(h)}:${pad(m)}`;

  if (dom === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*") {
    const label = weekdays(dow);
    return label ? `${label} at ${time}` : undefined;
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom)) {
    const d = Number(dom);
    return d >= 1 && d <= 28 ? `Monthly on the ${ordinal(d)} at ${time}` : undefined;
  }
  return undefined;
}
