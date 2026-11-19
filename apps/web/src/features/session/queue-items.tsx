import type { AgentSummary, QueueItem } from "@open-factory/shared";
import { Clock } from "lucide-react";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";
import { resetPhrase } from "./status-badge";

/** Why queued messages aren't out yet (S5 UI design §3.6), or the error that holds them. */
function heldReason(agent: AgentSummary): string | undefined {
  if (agent.status === "rate_limited") return `rate-limited${resetPhrase(agent)?.joined ?? ""}`;
  if (agent.status === "queued") return "waiting for a free slot";
  return agent.lastError;
}

/** Pending items, drawn only from `queue` frames (never inferred), at full opacity. */
export function QueueItems({ items, agent }: { items: QueueItem[]; agent: AgentSummary }) {
  const reason = heldReason(agent);
  return (
    <>
      {items.map((q) =>
        q.kind === "message" || q.kind === "notice" ? (
          <div key={q.id} className="pt-3">
            <MessageBlock
              from={q.from}
              system={q.kind === "notice"}
              body={q.body ?? ""}
              urgent={q.urgent}
              queued={{ reason }}
            />
          </div>
        ) : (
          <QuietLine key={q.id} icon={<Clock aria-hidden="true" />}>
            Compact queued until the turn ends{q.focus ? `: ${q.focus}` : ""}
          </QuietLine>
        ),
      )}
    </>
  );
}
