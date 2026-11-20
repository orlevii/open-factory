import { type AgentSummary, ApiError, type LiveCron } from "@open-factory/shared";
import { CircleStop } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { stopCrons } from "@/features/schedules/api";
import { browserZone } from "@/features/schedules/format";
import { focusComposer } from "./composer";
import { formatResetTime } from "./format";
import { StopCronsDialog } from "./stop-crons-dialog";

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function CronRow({ c, now }: { c: LiveCron; now: Date }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">
        <span title={c.humanSchedule}>{clip(c.humanSchedule)}</span>
        {!c.recurring && ", once"}
        {c.durable && <span className="text-muted-foreground"> (kept on disk)</span>}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {c.recurring
          ? c.expiresAt && `expires ${date(c.expiresAt)}`
          : c.nextFireAt && `next ${formatResetTime(new Date(c.nextFireAt), now)}`}
      </span>
    </li>
  );
}

export type StopCrons = {
  popover: boolean;
  setPopover(o: boolean): void;
  confirm: boolean;
  setConfirm(o: boolean): void;
  outcome: { text: string; key: number } | undefined;
  trigger: RefObject<HTMLButtonElement | null>;
  run(): Promise<void>;
};

/** The Stop crons state, held by the strip: the segment unmounts once the crons are gone, the dialog and outcome must not. */
export function useStopCrons(agent: AgentSummary): StopCrons {
  const [popover, setPopover] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; key: number } | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  // The outcome belongs to the crons it stopped: clear it when new ones appear (0 to above 0).
  const count = agent.crons.length;
  const prev = useRef(count);
  useEffect(() => {
    if (prev.current === 0 && count > 0) setOutcome(undefined);
    prev.current = count;
  }, [count]);
  async function run() {
    try {
      const r = await stopCrons(agent.slug);
      setOutcome({
        key: Date.now(),
        text:
          r.status === "stopped"
            ? `Stopped @${agent.slug}'s crons.`
            : `@${agent.slug}'s crons stop when its current work finishes.`,
      });
    } catch (e) {
      // The crons ended, or are ending, meanwhile: the goal is met.
      if (e instanceof ApiError && (e.code === "no_crons" || e.code === "stopping")) return;
      throw new ApiError(500, "stop_failed", "Couldn't stop the crons. Try again.");
    }
  }
  return { popover, setPopover, confirm, setConfirm, outcome, trigger, run };
}

/** The strip's "2 crons" (UI design §4.2): a text button that opens a popover listing the live crons with Stop crons. */
export function CronsSegment({ agent, stop }: { agent: AgentSummary; stop: StopCrons }) {
  const crons = agent.crons;
  const n = crons.length || agent.waitingOn.crons;
  const noun = n === 1 ? "cron" : "crons";
  const now = new Date();
  const zoneNote = agent.cronZone !== browserZone();
  return (
    <Popover open={stop.popover} onOpenChange={stop.setPopover}>
      <PopoverTrigger asChild>
        <button
          ref={stop.trigger}
          type="button"
          aria-haspopup="dialog"
          aria-label={`${n} ${noun}: show and stop`}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          {n} {noun}
          {agent.stopCronsPending && ` · stopping when @${agent.slug}'s current work finishes`}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        role="dialog"
        aria-label="Crons in this session"
        collisionPadding={8}
        // Opening the confirmation: focus belongs to it, not back to this button.
        onCloseAutoFocus={(e) => stop.confirm && e.preventDefault()}
        className="w-80 text-[0.8125rem] leading-[1.125rem]"
      >
        <p className="font-medium">Crons in this session</p>
        <ul className="grid gap-1">
          {crons.map((c) => (
            <CronRow key={c.cronId} c={c} now={now} />
          ))}
        </ul>
        <p className="border-t border-border pt-2 text-muted-foreground">
          {zoneNote && <>Cron times are in the server's zone ({agent.cronZone}). </>}
          They stop when the process stops. Stopping them hibernates @{agent.slug} once its current
          work is done.
        </p>
        {agent.stopCronsPending ? (
          <p className="text-muted-foreground">
            Stopping when @{agent.slug}'s current work finishes.
          </p>
        ) : (
          <Button
            variant="ghost"
            className="justify-self-end"
            onClick={() => {
              stop.setPopover(false);
              stop.setConfirm(true);
            }}
          >
            <CircleStop aria-hidden="true" data-icon="inline-start" className="text-destructive" />
            Stop {n} {noun}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The confirmation and the announced outcome, mounted by the strip so they outlive the segment. */
export function CronsStopLayer({ agent, stop }: { agent: AgentSummary; stop: StopCrons }) {
  return (
    <>
      <StopCronsDialog
        slug={agent.slug}
        crons={agent.crons}
        // Nothing left to stop (they ended while it was open): close rather than read "Stop 0 crons".
        open={stop.confirm && agent.crons.length > 0}
        onOpenChange={stop.setConfirm}
        onConfirm={stop.run}
        onCloseAutoFocus={(e) => {
          // Back to the strip's button, or to the composer once it is gone (the crons stopped).
          e.preventDefault();
          requestAnimationFrame(() =>
            stop.trigger.current?.isConnected ? stop.trigger.current.focus() : focusComposer(),
          );
        }}
      />
      {/* Mounted while the agent has crons (before it fills, so the outcome is announced) and after a stop. */}
      {(agent.crons.length > 0 || stop.outcome) && (
        <div className="px-4 md:px-6">
          <InlineOutcome {...(stop.outcome ? { tone: "success" as const } : {})}>
            {stop.outcome?.text}
          </InlineOutcome>
        </div>
      )}
    </>
  );
}
