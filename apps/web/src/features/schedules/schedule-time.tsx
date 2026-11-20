import { browserZone, formatScheduleTime, viewerTime } from "./format";

/** A schedule time as a `<time>` with the ISO instant, the zone muted, and the viewer's time in the title. */
export function ScheduleTime({
  at,
  zone,
  now = new Date(),
  showZone = true,
}: {
  at: string;
  zone: string;
  now?: Date;
  showZone?: boolean;
}) {
  const d = new Date(at);
  const f = formatScheduleTime(d, zone, now);
  const title =
    zone === browserZone()
      ? `${f.text} ${zone}`
      : `${f.text} ${zone} · ${viewerTime(d, zone, now)} your time`;
  return (
    <>
      <time dateTime={f.iso} title={title}>
        {f.text}
      </time>
      {showZone && <span className="text-muted-foreground"> {f.zone}</span>}
    </>
  );
}
