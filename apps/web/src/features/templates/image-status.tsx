import type { ImageStatus } from "@open-factory/shared";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Download,
  Loader2,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import { ago } from "@/features/settings/shared";
import { cn } from "@/lib/utils";

type Status = ImageStatus["status"];

/** Spec §12.8 / §12.10: every status is an icon plus a word; orange only for a running build. */
const META: Record<Status, { word: string; Icon: LucideIcon; tone: string }> = {
  building: { word: "Building…", Icon: Loader2, tone: "text-signal motion-safe:animate-spin" },
  failed: { word: "Build failed", Icon: CircleAlert, tone: "text-destructive" },
  out_of_date: { word: "Out of date", Icon: TriangleAlert, tone: "text-warning" },
  built: { word: "Built", Icon: CircleCheck, tone: "text-success" },
  not_built: { word: "Not built", Icon: Circle, tone: "text-muted-foreground" },
  no_dockerfile: { word: "No Dockerfile", Icon: CircleDashed, tone: "text-muted-foreground" },
  unknown: { word: "Unknown", Icon: CircleHelp, tone: "text-muted-foreground" },
  present: { word: "Present locally", Icon: CircleCheck, tone: "text-success" },
  pulled_on_start: { word: "Pulled when missing", Icon: Download, tone: "text-muted-foreground" },
};

/** "Built 2 hours ago" when the build time is known, else the plain word. */
export function imageStatusWord(status: Status, builtAt?: string): string {
  if (status === "built" && builtAt) return `Built ${ago(builtAt)}`;
  return META[status].word;
}

export function ImageStatusLabel({
  status,
  builtAt,
  className,
}: {
  status: Status;
  builtAt?: string;
  className?: string;
}) {
  const { Icon, tone } = META[status];
  return (
    <span data-image-status={status} className={cn("inline-flex items-center gap-1.5", className)}>
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", tone)} />
      {imageStatusWord(status, builtAt)}
    </span>
  );
}
