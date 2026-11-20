import type { ScheduleState as State } from "@open-factory/shared";
import { CalendarClock, CircleAlert, CircleCheck, CirclePause, CircleSlash } from "lucide-react";

/** State is icon plus label, never colour alone, and never orange (a schedule isn't "live"). UI design §1. */
export const STATE_VIEW = {
  active: { Icon: CalendarClock, label: "Active", icon: "text-muted-foreground", text: "" },
  paused: {
    Icon: CirclePause,
    label: "Paused",
    icon: "text-muted-foreground",
    text: "text-muted-foreground",
  },
  done: {
    Icon: CircleCheck,
    label: "Done",
    icon: "text-muted-foreground",
    text: "text-muted-foreground",
  },
  skipped_archived: {
    Icon: CircleSlash,
    label: "Skipped",
    icon: "text-muted-foreground",
    text: "",
  },
  pending_errored: { Icon: CircleAlert, label: "Waiting", icon: "text-destructive", text: "" },
} as const;

export function ScheduleState({ state, className = "" }: { state: State; className?: string }) {
  const v = STATE_VIEW[state];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${v.text} ${className}`}>
      <v.Icon aria-hidden="true" className={`size-3.5 shrink-0 ${v.icon}`} />
      {v.label}
    </span>
  );
}
