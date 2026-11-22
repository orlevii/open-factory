import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { restoreAgent } from "@/features/agents/lifecycle";

/**
 * "This agent is archived." with a Restore button, where the composer would be (U4 §6.5). The
 * button stays on screen, so the outcome is inline, not a toast; a success swaps this notice for
 * the composer.
 */
export function ArchivedNotice({
  slug,
  onRestored,
}: {
  slug: string;
  /** For a view that holds its own copy of the agent (the session), to pick up the restored one. */
  onRestored?: () => void;
}) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const [outcome, setOutcome] = useState<{ tone: "pending" | "error"; text: string }>();
  async function restore() {
    if (busy.current) return;
    busy.current = true;
    setOutcome({ tone: "pending", text: `Restoring @${slug}…` });
    const failed = await restoreAgent(slug, qc, { inline: true, onChanged: onRestored });
    busy.current = false;
    setOutcome(failed ? { tone: "error", text: failed } : undefined);
  }
  return (
    <div className="grid shrink-0 gap-1 border-t border-border px-4 py-3 md:px-6">
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
