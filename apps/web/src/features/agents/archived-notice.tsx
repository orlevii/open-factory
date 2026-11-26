import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { type AgentKey, restoreAgent } from "@/features/agents/lifecycle";

const COMPOSER_INPUT = '#composer [role="combobox"], #composer textarea';

/** Focuses the composer once it mounts (it replaces the notice after the agent's refetch); gives up
 *  after a few seconds, or as soon as focus lands somewhere else. */
function focusComposerWhenReady(from: Element | null) {
  const find = () => document.querySelector<HTMLElement>(COMPOSER_INPUT);
  const now = find();
  if (now) return now.focus();
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
  };
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== from) return stop();
    const el = find();
    if (el) {
      stop();
      el.focus();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setTimeout(stop, 5000);
}

/**
 * "This agent is archived." with a Restore button, where the composer would be (U4 §6.5). The
 * button stays on screen, so the outcome is inline, not a toast; a success swaps this notice for
 * the composer.
 */
export function ArchivedNotice({
  agent,
  onRestored,
}: {
  agent: AgentKey;
  /** For a view that holds its own copy of the agent (the session), to pick up the restored one. */
  onRestored?: () => void;
}) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const [outcome, setOutcome] = useState<{ tone: "pending" | "error"; text: string }>();
  async function restore() {
    if (busy.current) return;
    busy.current = true;
    setOutcome({ tone: "pending", text: `Restoring @${agent.handle}…` });
    // The Restore button goes away with the notice: focus follows to the composer that replaces it,
    // unless the user has moved on meanwhile.
    const active = document.activeElement;
    const held = () =>
      !document.activeElement ||
      document.activeElement === document.body ||
      document.activeElement === active ||
      !!box.current?.contains(document.activeElement);
    const failed = await restoreAgent(agent, qc, { inline: true, onChanged: onRestored });
    busy.current = false;
    setOutcome(failed ? { tone: "error", text: failed } : undefined);
    if (!failed && held()) focusComposerWhenReady(active);
  }
  return (
    <div ref={box} className="grid shrink-0 gap-1 border-t border-border px-4 py-3 md:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm text-muted-foreground">
          This agent is archived. Restore it to send messages.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={outcome?.tone === "pending" || undefined}
          onClick={() => void restore()}
        >
          Restore
        </Button>
      </div>
      <InlineOutcome tone={outcome?.tone}>{outcome?.text}</InlineOutcome>
    </div>
  );
}
