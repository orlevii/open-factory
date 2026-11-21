import { type AgentSummary, ApiError } from "@open-factory/shared";
import { type RefObject, useEffect, useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { stopCrons } from "@/features/schedules/api";
import { focusComposer } from "./composer";
import { StopCronsDialog } from "./stop-crons-dialog";

export type StopCrons = {
  popover: boolean;
  setPopover(o: boolean): void;
  confirm: boolean;
  setConfirm(o: boolean): void;
  outcome: { text: string; key: number } | undefined;
  trigger: RefObject<HTMLButtonElement | null>;
  run(): Promise<void>;
  returnFocus(): void;
};

/** The Stop crons state, held by the session view (U2 §8.4): Agent details' segment and the ⋯ menu
 *  open it, and both can unmount while the dialog and outcome must not. `undefined` until the
 *  session has an agent. */
export function useStopCrons(agent: AgentSummary | undefined): StopCrons {
  const [popover, setPopover] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; key: number } | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  // The outcome belongs to the crons it stopped: clear it when new ones appear (0 to above 0).
  const count = agent?.crons.length ?? 0;
  const prev = useRef(count);
  useEffect(() => {
    if (prev.current === 0 && count > 0) setOutcome(undefined);
    prev.current = count;
  }, [count]);
  // Radix calls onCloseAutoFocus on a timer after the dialog unmounts, and the focus waits a frame
  // more: by then the view may be gone (navigated away), and the composer found is another page's.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function returnFocus() {
    // Back to the segment's button, or to the composer once it is gone (the crons stopped or the
    // panel closed).
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      if (trigger.current?.isConnected) trigger.current.focus();
      else focusComposer();
    });
  }
  async function run() {
    if (!agent) return;
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
  return { popover, setPopover, confirm, setConfirm, outcome, trigger, run, returnFocus };
}

/** The confirmation and the announced outcome, mounted once by the session view so they outlive the
 *  segment and the menu. */
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
          e.preventDefault();
          stop.returnFocus();
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
