import { nextRuns, parseAt, validateCron } from "@open-factory/shared";
import { Fragment } from "react";
import { browserZone, formatScheduleTime, viewerTime } from "./format";

export type PreviewSource = { mode: "repeats" | "once"; cron: string; local: string; zone: string };

/** The preview's parts: each run (and its "your time") is kept whole when the line wraps. */
export type Preview = { lead: string; runs: { at: string; mine?: string }[]; zone: string };

/** The preview from what the fields held when it was last refreshed; undefined for invalid input. */
export function previewOf(p: PreviewSource, now = new Date()): Preview | undefined {
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
  if (p.mode === "once") runs = runs.slice(0, 1);
  const mine =
    p.zone !== browserZone()
      ? `(${viewerTime(runs[0] as Date, p.zone, now)} your time)`
      : undefined;
  return {
    lead: p.mode === "repeats" ? "Next runs:" : "Runs once:",
    runs: runs.map((r, i) => ({
      at: formatScheduleTime(r, p.zone, now).text,
      ...(i === 0 && mine ? { mine } : {}),
    })),
    zone: p.zone,
  };
}

/** Muted 13px block, `aria-live="polite"`; updated only when the form says so (blur, radio, zone), never per keystroke.
 *  Reads "Next runs: <run> · <run> · <run> <zone>"; a run never breaks inside itself. */
export function RunPreview({ preview }: { preview: Preview | undefined }) {
  return (
    <p
      aria-live="polite"
      className="min-h-[1.125rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
    >
      {preview && (
        <>
          {preview.lead}
          {preview.runs.map((r, i) => (
            <Fragment key={r.at}>
              {i === 0 ? " " : " · "}
              <span className="whitespace-nowrap">{r.at}</span>
              {r.mine && (
                <>
                  {" "}
                  <span className="whitespace-nowrap">{r.mine}</span>
                </>
              )}
            </Fragment>
          ))}{" "}
          {preview.zone}
        </>
      )}
    </p>
  );
}
