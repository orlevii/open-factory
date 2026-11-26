import { X } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { AgentChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { useHandle } from "@/features/agents/use-agent-index";
import { usePrincipalLookup } from "@/features/principals/use-principal";

/** What the live region says when the list changes (I1 §6.6). */
function announcement(
  prev: readonly string[],
  next: readonly string[],
  handleOf: (ref: string) => string,
): string | undefined {
  const added = next.find((s) => !prev.includes(s));
  if (added !== undefined) return `Also sending to @${handleOf(added)}`;
  const removed = prev.find((s) => !next.includes(s));
  return removed === undefined ? undefined : `Removed @${handleOf(removed)}`;
}

/** Two chip rows, in rem so the clamp follows text size (a 24px chip and a 4px gap each). */
function RemoveRecipient({
  agentRef,
  onRemove,
}: {
  agentRef: string;
  onRemove(agentRef: string): void;
}) {
  const handle = useHandle(agentRef);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Remove @${handle}`}
      className="size-6 shrink-0 text-muted-foreground"
      onClick={() => onRemove(agentRef)}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

const TWO_ROWS = "max-h-[3.25rem] max-md:max-h-6";

/**
 * The "To:" row above the text (I1 §6.6): "To: Ada" and one chip per recipient you added, shown only
 * once there is one. The live region is always there, so removing the last chip is still announced.
 * Chips take two rows (one below `md`), then "+N" opens them all in place. They appear and leave at once.
 */
export const Recipients = memo(function Recipients({
  primaryName,
  recipients,
  selected,
  onRemove,
}: {
  primaryName: string;
  /** Refs of the agents you added, in order. */
  recipients: readonly string[];
  /** The last chip is selected: the next Backspace removes it. */
  selected: boolean;
  onRemove(agentRef: string): void;
}) {
  const [prev, setPrev] = useState(recipients);
  const [prevSelected, setPrevSelected] = useState(selected);
  const [said, setSaid] = useState("");
  const lookup = usePrincipalLookup();
  const handleOf = (ref: string) => lookup(ref)?.handle ?? "…";
  // Adjusted during render on the list's or the selection's edge (no effect, one commit).
  if (prev !== recipients) {
    setPrev(recipients);
    setPrevSelected(selected);
    setSaid(announcement(prev, recipients, handleOf) ?? "");
  } else if (prevSelected !== selected) {
    setPrevSelected(selected);
    const last = recipients.at(-1);
    setSaid(selected && last ? `@${handleOf(last)} selected. Backspace again to remove` : "");
  }
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(0);
  const box = useRef<HTMLUListElement>(null);
  // How many chips the clamp cuts off: those below the box's visible height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chip list changes what is cut off
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || expanded) return;
    const count = () => {
      const limit = el.clientHeight;
      let n = 0;
      for (const c of el.children) if ((c as HTMLElement).offsetTop >= limit) n++;
      setHidden(n);
    };
    count();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, recipients]);
  const last = recipients.length - 1;
  return (
    <>
      <span role="status" className="sr-only">
        {said}
      </span>
      {recipients.length > 0 && (
        <div
          data-recipients
          className="flex min-w-0 items-start gap-2 px-2.5 pt-2 text-[0.8125rem] leading-6 text-muted-foreground"
        >
          {/* The name truncates (to at most 60% of the row) before the chips or "To:" give way. */}
          <span data-recipients-to className="flex min-w-0 max-w-[60%] shrink-0">
            <span className="shrink-0 whitespace-pre">To: </span>
            <span className="truncate text-foreground">{primaryName}</span>
          </span>
          <ul
            ref={box}
            aria-label="Also sending to"
            className={`flex min-w-0 flex-1 flex-wrap gap-1 overflow-hidden ${expanded ? "" : TWO_ROWS}`}
          >
            {recipients.map((agentRef, i) => (
              <li
                key={agentRef}
                data-recipient={agentRef}
                {...(selected && i === last ? { "data-selected": "" } : {})}
                className="inline-flex h-6 max-w-[min(12rem,100%)] min-w-0 items-center rounded-md border border-input pl-1.5 text-foreground data-selected:bg-muted"
              >
                <AgentChip agentRef={agentRef} size={16} />
                <RemoveRecipient agentRef={agentRef} onRemove={onRemove} />
              </li>
            ))}
          </ul>
          {hidden > 0 && !expanded && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              onClick={() => setExpanded(true)}
            >
              +{hidden}
            </Button>
          )}
        </div>
      )}
    </>
  );
});
