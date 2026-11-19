import type { AgentSummary, QueueItem } from "@open-factory/shared";
import { Clock } from "lucide-react";
import { formatResetTime } from "./format";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";
import { resetPhrase } from "./status-badge";

/** Why queued messages aren't out yet (S5 UI design §3.6), or the error that holds them. */
function heldReason(agent: AgentSummary): string | undefined {
  if (agent.status === "rate_limited") return `rate-limited${resetPhrase(agent)?.joined ?? ""}`;
  if (agent.status === "queued") return "waiting for a free slot";
  return agent.lastError;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One quiet line per held group (S6 UI design §2.6): fixed text, nothing ticks, outside any live
 *  region. `rate_limited` reuses S5's reset phrase; a window shows its fixed `dueAt`. */
function HeldLine({ item, agent }: { item: QueueItem; agent: AgentSummary }) {
  const count = plural(item.count ?? 1, "update", "updates");
  const tail = (() => {
    switch (item.waitReason) {
      case "turn":
        return " waiting for this turn to end";
      case "window": {
        const due = item.dueAt ? new Date(item.dueAt) : undefined;
        return due && !Number.isNaN(due.getTime())
          ? `, delivered by ${formatResetTime(due, new Date())}`
          : "";
      }
      case "starting":
        return " waiting for this agent to start";
      case "errored":
        return " held until a human restarts this agent";
      case "rate_limited": {
        const phrase = resetPhrase(agent)?.bare;
        return phrase ? ` held ${phrase}` : " held";
      }
      default:
        return "";
    }
  })();
  // Window without a due time, or a reason this client doesn't know: still say they are waiting.
  const text = tail.startsWith(" held") || tail.startsWith(" waiting") ? tail : ` waiting${tail}`;
  return (
    <QuietLine icon={<Clock aria-hidden="true" />}>
      {count} from <span className="font-mono">@{item.from}</span>
      {text}
    </QuietLine>
  );
}

/** Pending items, drawn only from `queue` frames (never inferred), at full opacity. */
export function QueueItems({ items, agent }: { items: QueueItem[]; agent: AgentSummary }) {
  const reason = heldReason(agent);
  const peerChanges = items
    .filter((q) => q.kind === "held" && q.waitReason === "ride_along")
    .reduce((n, q) => n + (q.count ?? 1), 0);
  const firstPeer = items.find((q) => q.kind === "held" && q.waitReason === "ride_along");
  return (
    <>
      {items.map((q) =>
        q.kind === "held" ? (
          q.waitReason === "ride_along" ? (
            q === firstPeer && (
              <QuietLine key={q.id} icon={<Clock aria-hidden="true" />}>
                {plural(peerChanges, "peer change", "peer changes")} waiting
              </QuietLine>
            )
          ) : (
            <HeldLine key={q.id} item={q} agent={agent} />
          )
        ) : q.kind === "message" || q.kind === "notice" ? (
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
