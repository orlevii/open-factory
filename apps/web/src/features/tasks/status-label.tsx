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

/** "Blocked by T-41, T-44": the marker (a `warning` icon with an ink label). */
export function BlockedMarker({ keys, className = "" }: { keys: string[]; className?: string }) {
  if (!keys.length) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 text-foreground ${className}`}>
      <CircleMinus aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      Blocked by {keys.join(", ")}
    </span>
  );
}
