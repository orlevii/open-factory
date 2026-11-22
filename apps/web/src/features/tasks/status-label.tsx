import type { TaskStatus } from "@open-factory/shared";
import { Circle, CircleCheck, CircleDot, CircleMinus, CircleSlash } from "lucide-react";
import type { ComponentType } from "react";

/** UI design §1: an icon plus the label, never colour alone and never orange (a task status is not "live"). */
export const STATUS: Record<
  TaskStatus,
  {
    label: string;
    sentence: string;
    Icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
    icon: string;
    text: string;
  }
> = {
  open: {
    label: "Open",
    sentence: "open",
    Icon: Circle,
    icon: "text-muted-foreground",
    text: "text-foreground",
  },
  in_progress: {
    label: "In progress",
    sentence: "in progress",
    Icon: CircleDot,
    icon: "text-foreground",
    text: "text-foreground",
  },
  done: {
    label: "Done",
    sentence: "done",
    Icon: CircleCheck,
    icon: "text-success",
    text: "text-foreground",
  },
  cancelled: {
    label: "Cancelled",
    sentence: "cancelled",
    Icon: CircleSlash,
    icon: "text-muted-foreground",
    text: "text-muted-foreground",
  },
};

export function StatusLabel({
  status,
  className = "",
}: {
  status: TaskStatus;
  className?: string;
}) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${s.text} ${className}`}>
      <s.Icon aria-hidden="true" className={`size-3.5 shrink-0 ${s.icon}`} />
      {s.label}
    </span>
  );
}

/** "Blocked by T-41, T-44": the marker (a `warning` icon with an ink label). With `max` and more keys it
 *  shows the first `max` and "+N more", the full list in `title`. `labelClassName` styles the label, where an
 *  `after:` separator flows inline after its last word even when the label wraps; the icon stays on its first line. */
export function BlockedMarker({
  keys,
  max,
  className = "",
  labelClassName = "",
}: {
  keys: string[];
  max?: number;
  className?: string;
  labelClassName?: string;
}) {
  if (!keys.length) return null;
  const capped = max !== undefined && keys.length > max;
  const shown = capped ? keys.slice(0, max) : keys;
  return (
    <span className={`inline-flex items-start gap-1.5 text-foreground ${className}`}>
      <CircleMinus
        aria-hidden="true"
        className="mt-[calc((1lh-0.875rem)/2)] size-3.5 shrink-0 text-warning"
      />
      <span title={capped ? keys.join(", ") : undefined} className={`min-w-0 ${labelClassName}`}>
        Blocked by {shown.join(", ")}
        {capped ? ` +${keys.length - shown.length} more` : ""}
      </span>
    </span>
  );
}
