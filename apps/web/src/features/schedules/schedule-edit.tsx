import type { ScheduleItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CirclePause, CirclePlay, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  deleteSchedule,
  type PatchScheduleBody,
  patchSchedule,
  pauseSchedule,
  restoreSchedule,
  resumeSchedule,
  scheduleDetailOptions,
  schedulesQueryKey,
} from "./api";
import { BackLink } from "./back-link";
import { ScheduleForm } from "./schedule-form";
import { firstLine } from "./schedule-row";
import { ScheduleState } from "./schedule-state";
import { ScheduleTime } from "./schedule-time";

const who = (a: ScheduleItem["createdBy"]) => (a.kind === "user" ? `@${a.handle}` : `@${a.slug}`);

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <Button variant="ghost" className="max-md:hidden" onClick={onClick} disabled={disabled}>
        {children}
        {label}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** The edit page (UI design §3, edit only): header line, pause/resume/delete, the form, the deleted state. */
export function ScheduleEdit({ scheduleKey }: { scheduleKey: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: s, isError, refetch } = useQuery(scheduleDetailOptions(scheduleKey));
  const [saved, setSaved] = useState(false);
  const [restoreState, setRestoreState] = useState<"idle" | "pending" | "failed">("idle");
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: schedulesQueryKey });
  const now = new Date();

  if (!s)
    return (
      <>
        <PageHeader title={scheduleKey} />
        <PageBody>
          {isError && (
            <ErrorLine text="Couldn't load the schedule." onRetry={() => void refetch()} />
          )}
        </PageBody>
      </>
    );

  const deleted = Boolean(s.deleted);
  const run = async (what: "pause" | "resume") => {
    setActionFailed(null);
    try {
      await (what === "pause" ? pauseSchedule : resumeSchedule)(scheduleKey);
      await refresh();
    } catch {
      setActionFailed(`Couldn't ${what} ${scheduleKey}.`);
    }
  };
  const remove = async () => {
    setActionFailed(null);
    try {
      await deleteSchedule(scheduleKey);
      await refresh();
      await navigate({
        to: "/schedules",
        search: {},
        state: { outcome: { text: `Deleted ${scheduleKey}.`, undoKey: scheduleKey } } as never,
      });
    } catch {
      setActionFailed(`Couldn't delete ${scheduleKey}.`);
    }
  };
  const restore = async () => {
    setRestoreState("pending");
    try {
      await restoreSchedule(scheduleKey);
      setRestoreState("idle");
      await refresh();
    } catch {
      setRestoreState("failed");
    }
  };

  return (
    <>
      <PageHeader
        title={scheduleKey}
        heading={<span className="font-mono">{scheduleKey}</span>}
        documentTitle={`${scheduleKey} · ${firstLine(s.body)}`}
        actions={
          deleted ? undefined : (
            <>
              {!s.done &&
                (s.paused ? (
                  <IconButton label="Resume" onClick={() => void run("resume")}>
                    <CirclePlay aria-hidden="true" data-icon="inline-start" />
                  </IconButton>
                ) : (
                  <IconButton label="Pause" onClick={() => void run("pause")}>
                    <CirclePause aria-hidden="true" data-icon="inline-start" />
                  </IconButton>
                ))}
              <IconButton label="Delete" onClick={() => void remove()}>
                <Trash2 aria-hidden="true" data-icon="inline-start" />
              </IconButton>
            </>
          )
        }
      />
      <PageBody>
        <div className="grid gap-4">
          <BackLink />
          {deleted ? (
            <div className="grid max-w-[720px] justify-items-start gap-2">
              <p className="text-sm">{scheduleKey} was deleted.</p>
              {!s.target.terminated && (
                <Button onClick={() => void restore()} disabled={restoreState === "pending"}>
                  {restoreState === "pending" ? "Restoring…" : "Restore"}
                </Button>
              )}
              {restoreState === "failed" && (
                <ErrorLine
                  text={`Couldn't restore ${scheduleKey}.`}
                  onRetry={() => void restore()}
                />
              )}
            </div>
          ) : (
            <div className="grid max-w-[720px] gap-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              <p className="flex flex-wrap items-center gap-x-1.5">
                <ScheduleState state={s.state} className="text-foreground" />
                <span aria-hidden="true">·</span>
                <span>
                  created by <span className="font-mono">{who(s.createdBy)}</span>
                </span>
                {who(s.createdBy) !== who(s.bodyAuthor) && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      last written by <span className="font-mono">{who(s.bodyAuthor)}</span>
                    </span>
                  </>
                )}
                {s.lastFiredAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      last run <ScheduleTime at={s.lastFiredAt} zone={s.timezone} now={now} />
                    </span>
                  </>
                )}
              </p>
              {s.done && <p>Done. Set a future date and time to run it again.</p>}
              {s.pendingFiring && (
                <p>
                  {s.state === "pending_errored"
                    ? `A run is waiting for @${s.target.slug}, which is errored. Edits apply from the next run.`
                    : `A run is waiting to be delivered to @${s.target.slug}. Edits apply from the next run.`}
                </p>
              )}
              {actionFailed && (
                <p role="alert" className="text-destructive">
                  {actionFailed}
                </p>
              )}
            </div>
          )}
          <ScheduleForm
            initial={s}
            readOnly={deleted}
            agentAuthored={s.bodyAuthor.kind === "agent"}
            saved={saved}
            onSubmit={async (body) => {
              setSaved(false);
              await patchSchedule(scheduleKey, body as PatchScheduleBody);
              await refresh();
              setSaved(true);
            }}
          />
        </div>
      </PageBody>
    </>
  );
}
