import { ApiError, type ScheduleItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorLine } from "@/components/error-line";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { onRowKeyDown } from "@/lib/row-nav";
import {
  deleteSchedule,
  pauseSchedule,
  restoreSchedule,
  resumeSchedule,
  type ScheduleFilters,
  schedulesListOptions,
  schedulesQueryKey,
} from "./api";
import { formatScheduleTime } from "./format";
import { isDefault } from "./schedule-filters";
import { ScheduleRow } from "./schedule-row";

export type Outcome = {
  tone: "success" | "error";
  text: React.ReactNode;
  undo?: () => void;
  retry?: () => void;
  key: number;
};

let outcomeKey = 0;

export function ScheduleList({
  filters,
  onChange,
}: {
  filters: ScheduleFilters;
  onChange(next: ScheduleFilters): void;
}) {
  const qc = useQueryClient();
  const q = useQuery(schedulesListOptions(filters));
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focusMenu, setFocusMenu] = useState<string | null>(null);

  const say = (o: Omit<Outcome, "key">) => setOutcome({ ...o, key: ++outcomeKey });
  const refresh = () => qc.invalidateQueries({ queryKey: schedulesQueryKey });

  async function restore(key: string) {
    try {
      const s = await restoreSchedule(key);
      setHidden((h) => new Set([...h].filter((k) => k !== key)));
      await refresh();
      if (s.done && !filters.done)
        say({
          tone: "success",
          text: (
            <>
              Restored {key}. It's done, so it's hidden.{" "}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onChange({ ...filters, done: true })}
              >
                Show done
              </Button>
            </>
          ),
        });
      else {
        say({ tone: "success", text: `Restored ${key}.` });
        setFocusMenu(key);
      }
    } catch (e) {
      const code = e instanceof ApiError ? { code: e.code, message: e.message } : undefined;
      say({
        tone: "error",
        text:
          code?.code === "target_ended"
            ? `${key} can't be restored: ${code.message}`
            : `Couldn't restore ${key}.`,
        ...(code?.code === "target_ended" ? {} : { retry: () => void restore(key) }),
      });
    }
  }

  async function act(key: string, kind: "pause" | "resume" | "delete") {
    const fn = { pause: pauseSchedule, resume: resumeSchedule, delete: deleteSchedule }[kind];
    if (kind === "delete") setHidden((h) => new Set(h).add(key));
    try {
      const s = await fn(key);
      await refresh();
      if (kind === "delete")
        say({ tone: "success", text: `Deleted ${key}.`, undo: () => void restore(key) });
      else if (kind === "pause") say({ tone: "success", text: `Paused ${key}.` });
      else {
        const next = s.nextRunAt
          ? formatScheduleTime(new Date(s.nextRunAt), s.timezone, new Date())
          : undefined;
        say({
          tone: "success",
          text: next ? `Resumed ${key}. Next run: ${next.text} ${next.zone}.` : `Resumed ${key}.`,
        });
      }
    } catch {
      if (kind === "delete") setHidden((h) => new Set([...h].filter((k) => k !== key)));
      say({
        tone: "error",
        text: `Couldn't ${kind} ${key}.`,
        retry: () => void act(key, kind),
      });
    }
  }

  // After Undo: focus goes to the restored row's menu button once it is back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the row reappears
  useEffect(() => {
    if (!focusMenu) return;
    const b = document.querySelector<HTMLElement>(`[data-menu-key="${focusMenu}"]`);
    if (b) {
      b.focus();
      setFocusMenu(null);
    }
  }, [focusMenu, q.data]);

  const data = q.data;
  const shown: ScheduleItem[] = (data?.schedules ?? []).filter((s) => !hidden.has(s.key));
  const now = new Date();
  const outcomeLine = (
    <InlineOutcome
      {...(outcome ? { tone: outcome.tone } : {})}
      {...(outcome?.undo ? { undo: outcome.undo } : {})}
      focusKey={outcome?.undo ? outcome.key : undefined}
    >
      {outcome?.text}
      {outcome?.retry && (
        <Button variant="ghost" size="xs" onClick={outcome.retry}>
          Retry
        </Button>
      )}
    </InlineOutcome>
  );
  if (!data)
    return (
      <div className="grid gap-4">
        {outcomeLine}
        {q.isError && (
          <ErrorLine text="Couldn't load schedules." onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  let body: React.ReactNode;
  if (shown.length === 0) {
    body = isDefault(filters) ? (
      <EmptyState text="No schedules yet." />
    ) : (
      <div className="grid justify-items-start gap-2">
        <EmptyState text="No schedules match these filters." />
        <Button variant="ghost" onClick={() => onChange({})}>
          Clear filters
        </Button>
      </div>
    );
  } else
    body = (
      <ul aria-label="Schedules" onKeyDown={onRowKeyDown} className="border-y border-border">
        {shown.map((s) => (
          <ScheduleRow
            key={s.key}
            s={s}
            now={now}
            onPause={() => void act(s.key, "pause")}
            onResume={() => void act(s.key, "resume")}
            onDelete={() => void act(s.key, "delete")}
          />
        ))}
      </ul>
    );
  return (
    <div className="grid gap-4">
      {outcomeLine}
      {body}
      {data.more && (
        <p className="text-muted-foreground text-sm">Showing the first 500 schedules.</p>
      )}
    </div>
  );
}
