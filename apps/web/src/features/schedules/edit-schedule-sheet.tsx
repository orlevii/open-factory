import { ApiError, type ScheduleItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause, CirclePlay } from "lucide-react";
import { useRef, useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetClose, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BodySkeleton } from "@/features/sheets/body-skeleton";
import { clearDraft } from "@/features/sheets/drafts";
import { useFocusOnOpen } from "@/features/sheets/focus-on-open";
import { SheetHeaderActions } from "@/features/sheets/header-slot";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { getSheetState, openSheet } from "@/features/sheets/sheet-store";
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
import { describeCron } from "./describe-cron";
import { firstLine } from "./first-line";
import { ScheduleForm } from "./schedule-form";
import { ScheduleState } from "./schedule-state";
import { ScheduleTime } from "./schedule-time";

type Spec = { kind: "edit-schedule"; key: string; at?: string };

const who = (a: ScheduleItem["createdBy"]) => (a.kind === "user" ? `@${a.handle}` : `@${a.slug}`);

function Description({ s }: { s: ScheduleItem }) {
  return (
    <SheetDescription className="shrink-0 truncate px-4 pt-3" title={firstLine(s.body)}>
      {firstLine(s.body)}
    </SheetDescription>
  );
}

function CloseFooter() {
  return (
    <SheetFooter>
      <SheetClose asChild>
        <Button type="button" variant="ghost">
          Close
        </Button>
      </SheetClose>
    </SheetFooter>
  );
}

function Plain({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SheetBody className="grid content-start justify-items-start gap-3 text-sm">
        {children}
      </SheetBody>
      <CloseFooter />
    </>
  );
}

/** Pause or Resume: the header's action before Close, icon only with a tooltip. */
function PauseResume({ s, onError }: { s: ScheduleItem; onError(text: string | null): void }) {
  const qc = useQueryClient();
  if (s.done) return null;
  const what = s.paused ? "resume" : "pause";
  const label = `${s.paused ? "Resume" : "Pause"} ${s.key}`;
  const Icon = s.paused ? CirclePlay : CirclePause;
  return (
    <SheetHeaderActions>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={label}
            onClick={async () => {
              onError(null);
              try {
                await (s.paused ? resumeSchedule : pauseSchedule)(s.key);
                await qc.invalidateQueries({ queryKey: schedulesQueryKey });
              } catch {
                onError(`Couldn't ${what} ${s.key}.`);
              }
            }}
          >
            <Icon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </SheetHeaderActions>
  );
}

function StateLine({ s, actionFailed }: { s: ScheduleItem; actionFailed: string | null }) {
  const now = new Date();
  return (
    <div className="grid gap-1 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
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
  );
}

/** A deleted schedule, as text: Restore (unless its target ended) turns it back into the live form. */
function Deleted({ s }: { s: ScheduleItem }) {
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const body = useRef<HTMLDivElement>(null);
  useFocusOnOpen(body, "button");
  const restore = async () => {
    setState("pending");
    try {
      await restoreSchedule(s.key);
      await qc.invalidateQueries({ queryKey: schedulesQueryKey });
    } catch {
      setState("failed");
      return;
    }
    setState("idle");
  };
  return (
    <>
      <Description s={s} />
      <SheetBody ref={body} className="grid content-start gap-4">
        <div className="grid justify-items-start gap-2">
          <p className="text-sm">{s.key} was deleted.</p>
          {!s.target.terminated && (
            <Button type="button" onClick={() => void restore()} disabled={state === "pending"}>
              {state === "pending" ? "Restoring…" : "Restore"}
            </Button>
          )}
          {state === "failed" && (
            <ErrorLine text={`Couldn't restore ${s.key}.`} onRetry={() => void restore()} />
          )}
        </div>
        <dl className="grid gap-3 text-sm">
          <div className="grid gap-0.5">
            <dt className="text-[0.8125rem] text-muted-foreground">Target</dt>
            <dd className="font-mono">@{s.target.slug}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-[0.8125rem] text-muted-foreground">When</dt>
            <dd>
              {s.cron ? (
                (describeCron(s.cron) ?? <span className="font-mono">{s.cron}</span>)
              ) : s.at ? (
                <ScheduleTime at={s.at} zone={s.timezone} showZone={false} />
              ) : (
                "Once"
              )}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-[0.8125rem] text-muted-foreground">Time zone</dt>
            <dd>{s.timezone}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-[0.8125rem] text-muted-foreground">Message</dt>
            <dd>
              <Markdown source={s.body} variant="detail" untrusted />
            </dd>
          </div>
        </dl>
      </SheetBody>
      <CloseFooter />
    </>
  );
}

/** The live form: header Pause/Resume, the state line, the fields, Save changes and Delete schedule. */
function Live({ s, spec, sheetId, close }: { s: ScheduleItem } & BodyProps<Spec>) {
  const qc = useQueryClient();
  const key = s.key;
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const draftKey = `edit-schedule:${key}` as const;
  const stillOpen = () => getSheetState().parent?.id === sheetId;
  // A late result must not wipe a draft the user restored by reopening this schedule while it was in flight.
  const reopened = () => {
    const p = getSheetState().parent;
    return (
      p?.kind === "edit-schedule" && p.key.toUpperCase() === key.toUpperCase() && p.id !== sheetId
    );
  };
  const refresh = () => qc.invalidateQueries({ queryKey: schedulesQueryKey });

  const [deleting, setDeleting] = useState(false);
  const deleteBusy = useRef(false);
  async function remove() {
    if (deleteBusy.current) return;
    deleteBusy.current = true;
    setDeleting(true);
    setActionFailed(null);
    try {
      await deleteSchedule(key);
    } catch (err) {
      deleteBusy.current = false;
      setDeleting(false);
      if (stillOpen()) {
        setActionFailed(`Couldn't delete ${key}.`);
        return;
      }
      notify({
        text:
          err instanceof ApiError
            ? err.message
            : "Couldn't delete the schedule: can't reach the server.",
        action: { label: "Open form", run: () => openSheet({ kind: "edit-schedule", key }) },
      });
      return;
    }
    if (!reopened()) clearDraft(draftKey);
    if (stillOpen()) close();
    void refresh();
    notify({
      text: `Deleted ${key}.`,
      undo: async () => {
        await restoreSchedule(key);
        await refresh();
      },
    });
  }

  return (
    <>
      <PauseResume s={s} onError={setActionFailed} />
      <Description s={s} />
      <ScheduleForm
        initial={s}
        agentAuthored={s.bodyAuthor.kind === "agent"}
        lead={<StateLine s={s} actionFailed={actionFailed} />}
        locked={deleting}
        footerLeft={(saving) => (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={saving || deleting}
            onClick={() => void remove()}
          >
            Delete schedule
          </Button>
        )}
        onSubmit={async (body) => {
          try {
            await patchSchedule(key, body as PatchScheduleBody);
          } catch (err) {
            if (stillOpen()) throw err;
            notify({
              text:
                err instanceof ApiError
                  ? err.message
                  : "Couldn't save the schedule: can't reach the server.",
              action: { label: "Open form", run: () => openSheet({ kind: "edit-schedule", key }) },
            });
            return;
          }
          if (!reopened()) clearDraft(draftKey);
          void refresh();
          const late = !stillOpen();
          if (!late) close();
          // Silent only when the list under the sheet shows the result at once; a late result always says so.
          if (late || spec.at !== "/schedules") notify({ text: `Saved ${key}.` });
        }}
      />
    </>
  );
}

/** The Edit schedule sheet body (§9.2): live form, deleted state as text, or not found. */
export default function EditScheduleSheet(props: BodyProps<Spec>) {
  const key = props.spec.key;
  const { data: s, error, refetch } = useQuery(scheduleDetailOptions(key));
  if (!s) {
    if (error instanceof ApiError && error.code === "schedule_not_found")
      return <Plain>There is no schedule {key}.</Plain>;
    if (error)
      return (
        <Plain>
          <ErrorLine text="Couldn't load the schedule." onRetry={() => void refetch()} />
        </Plain>
      );
    return <BodySkeleton kind="edit-schedule" />;
  }
  return s.deleted ? <Deleted s={s} /> : <Live s={s} {...props} />;
}
