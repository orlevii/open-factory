import { LINK_CLASS } from "@/features/session/message-block";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";

/** `S-3` in mono, a button that opens the schedule's sheet (a deleted one opens in its deleted state), or plain text inside a link. */
export function ScheduleBadge({
  scheduleKey,
  link = true,
}: {
  scheduleKey: string;
  link?: boolean;
}) {
  const base = "font-mono text-[0.8125rem] leading-[1.125rem] text-foreground";
  if (!link) return <span className={base}>{scheduleKey}</span>;
  const spec = { kind: "edit-schedule", key: scheduleKey } as const;
  return (
    <button
      type="button"
      aria-label={`Schedule ${scheduleKey}`}
      className={`${base} ${LINK_CLASS}`}
      onPointerEnter={() => preloadSheet("edit-schedule", spec)}
      onFocus={() => preloadSheet("edit-schedule", spec)}
      onClick={() => openSheet(spec)}
    >
      {scheduleKey}
    </button>
  );
}
