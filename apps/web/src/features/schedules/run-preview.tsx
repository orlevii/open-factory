import { nextRuns, parseAt, validateCron } from "@open-factory/shared";
import { browserZone, formatScheduleTime, viewerTime } from "./format";

export type PreviewSource = { mode: "repeats" | "once"; cron: string; local: string; zone: string };

/** The preview's text from what the fields held when it was last refreshed; undefined for invalid input. */
export function previewText(p: PreviewSource, now = new Date()): string | undefined {
  let runs: Date[];
  if (p.mode === "repeats") {
    if (!p.cron.trim() || validateCron(p.cron)) return undefined;
    runs = nextRuns(p.cron.trim(), p.zone, now, 3);
  } else {
    const at = p.local ? parseAt(p.local, p.zone) : null;
    if (!at || at.getTime() <= now.getTime()) return undefined;
    runs = [at];
  }
  if (!runs.length) return undefined;
  const fmt = runs.map((r) => formatScheduleTime(r, p.zone, now).text);
  const mine =
    p.zone !== browserZone() ? ` (${viewerTime(runs[0] as Date, p.zone, now)} your time)` : "";
  return p.mode === "repeats"
    ? `Next runs: ${fmt.map((t, i) => (i === 0 ? `${t}${mine}` : t)).join(" · ")} ${p.zone}`
    : `Runs once: ${fmt[0]}${mine} ${p.zone}`;
}

/** Muted 13px block, `aria-live="polite"`; updated only when the form says so (blur, radio, zone), never per keystroke. */
export function RunPreview({ text }: { text: string | undefined }) {
  return (
    <p
      aria-live="polite"
      className="min-h-[1.125rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
    >
      {text}
    </p>
  );
}
