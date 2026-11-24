import type { ScheduleAuthor, ScheduleItem } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuSeparator,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { useLongPressMenu } from "@/hooks/use-long-press-menu";
import { firstLine } from "./first-line";
import { formatScheduleTime } from "./format";
import { ScheduleState, STATE_VIEW } from "./schedule-state";
import { ScheduleTime } from "./schedule-time";

const who = (a: ScheduleAuthor) =>
  a.kind === "user"
    ? `@${a.handle}`
    : `@${a.slug}${a.terminated ? " (terminated)" : a.archived ? " (archived)" : ""}`;
const whoPlain = (a: ScheduleAuthor) => (a.kind === "user" ? `@${a.handle}` : `@${a.slug}`);

function when(s: ScheduleItem, now: Date) {
  const t = (iso: string) => <ScheduleTime at={iso} zone={s.timezone} now={now} />;
  const pattern = s.cron ? <span className="font-mono">{s.cron}</span> : <span>Once</span>;
  let tail: React.ReactNode;
  if (s.state === "done")
    tail = s.ran ? (
      <>Ran {s.lastFiredAt ? t(s.lastFiredAt) : null}</>
    ) : (
      <>Didn't run: @{s.target.slug} was archived</>
    );
  else if (s.state === "paused") tail = "—";
  else if (!s.nextRunAt) tail = "—";
  else if (s.state === "skipped_archived") tail = <>Next: {t(s.nextRunAt)} (skipped)</>;
  else tail = s.cron ? <>Next: {t(s.nextRunAt)}</> : t(s.nextRunAt);
  return { pattern, tail };
}

function accessibleName(s: ScheduleItem, now: Date) {
  const next = s.nextRunAt ? formatScheduleTime(new Date(s.nextRunAt), s.timezone, now) : undefined;
  const target = `to @${s.target.slug}${s.state === "pending_errored" ? " (target errored)" : s.target.archived ? " (target archived)" : ""}`;
  const rep = s.cron ? `repeats ${s.cron}` : "once";
  const nxt = next ? `, next run ${next.text} ${next.zone}` : "";
  const by =
    s.createdBy.kind === s.bodyAuthor.kind && whoPlain(s.createdBy) === whoPlain(s.bodyAuthor)
      ? `by ${whoPlain(s.createdBy)}`
      : `created by ${whoPlain(s.createdBy)}, last written by ${whoPlain(s.bodyAuthor)}`;
  return `${s.key}, ${target}, ${rep}${nxt}, ${STATE_VIEW[s.state].label}, ${by}`;
}

export function ScheduleRow({
  s,
  now,
  onPause,
  onResume,
  onDelete,
}: {
  s: ScheduleItem;
  now: Date;
  onPause(): void;
  onResume(): void;
  onDelete(): void;
}) {
  const { pattern, tail } = when(s, now);
  const same = whoPlain(s.createdBy) === whoPlain(s.bodyAuthor);
  const line = firstLine(s.body);
  const spec = { kind: "edit-schedule", key: s.key } as const;
  // A long-press anywhere on the row opens its menu at the point (U4 §11.2); the ⋯ stays.
  const { press, menu } = useLongPressMenu();
  return (
    <li
      {...press}
      data-longpress-region=""
      data-row-box=""
      className="relative border-b border-border last:border-b-0 hover:bg-sidebar-accent"
    >
      <div className="grid min-h-[4.5rem] gap-y-0.5 px-2 py-2 text-sm">
        <div className="flex min-w-0 items-center gap-x-3">
          <button
            type="button"
            aria-label={accessibleName(s, now)}
            aria-describedby={`first-line-${s.key}`}
            data-schedule-key={s.key}
            data-row=""
            className="w-14 shrink-0 cursor-pointer text-left font-mono text-[0.8125rem] leading-5 text-foreground after:absolute after:inset-0 focus-visible:outline-transparent focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
            onPointerEnter={() => preloadSheet("edit-schedule", spec)}
            onFocus={() => preloadSheet("edit-schedule", spec)}
            onClick={() => openSheet(spec)}
          >
            {s.key}
          </button>
          <span className="relative z-10 min-w-0 truncate leading-5">
            <Link
              to="/agents/$slug/chat"
              params={{ slug: s.target.slug }}
              className={`font-mono hover:underline ${s.target.archived || s.target.terminated ? "text-muted-foreground" : "text-foreground"}`}
            >
              @{s.target.slug}
            </Link>
            {s.state === "skipped_archived" && (
              <span className="text-muted-foreground"> · archived</span>
            )}
            {s.state === "pending_errored" && (
              <span className="text-muted-foreground"> · errored</span>
            )}
            {s.target.terminated && <span className="text-muted-foreground"> · terminated</span>}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <ScheduleState state={s.state} className="text-[0.8125rem] leading-5" />
            <AdaptiveMenu title={s.key} {...menu}>
              <AdaptiveMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative z-10"
                  aria-label={`Actions for ${s.key}`}
                  data-menu-key={s.key}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </AdaptiveMenuTrigger>
              <AdaptiveMenuContent align="end">
                <AdaptiveMenuItem opensOverlay onSelect={() => openSheet(spec)}>
                  Edit
                </AdaptiveMenuItem>
                {!s.done &&
                  (s.paused ? (
                    <AdaptiveMenuItem onSelect={onResume}>Resume</AdaptiveMenuItem>
                  ) : (
                    <AdaptiveMenuItem onSelect={onPause}>Pause</AdaptiveMenuItem>
                  ))}
                <AdaptiveMenuSeparator />
                <AdaptiveMenuItem variant="destructive" onSelect={onDelete}>
                  Delete
                </AdaptiveMenuItem>
              </AdaptiveMenuContent>
            </AdaptiveMenu>
          </span>
        </div>
        <div className="truncate pl-[4.25rem] text-[0.8125rem] leading-[1.125rem] text-foreground">
          {pattern}
          <span className="text-muted-foreground"> · </span>
          <span>{tail}</span>
        </div>
        <div
          id={`first-line-${s.key}`}
          className="truncate pl-[4.25rem] leading-5 text-muted-foreground"
        >
          {line}
        </div>
        <div className="pl-[4.25rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {same ? (
            <>
              by <span className="font-mono">{who(s.createdBy)}</span>
            </>
          ) : (
            <>
              created by <span className="font-mono">{who(s.createdBy)}</span> · last written by{" "}
              <span className="font-mono">{who(s.bodyAuthor)}</span>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
