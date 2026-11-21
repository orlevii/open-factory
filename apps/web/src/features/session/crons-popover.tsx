import type { AgentSummary, LiveCron } from "@open-factory/shared";
import { CircleStop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { browserZone } from "@/features/schedules/format";
import { formatResetTime } from "./format";
import type { StopCrons } from "./stop-crons";

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
