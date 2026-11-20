import type { QueueItem } from "@open-factory/shared";
import { Clock } from "lucide-react";
import { MessageBlock } from "./message-block";
import { QuietLine } from "./quiet-line";

/** Pending items, drawn only from `queue` frames (never inferred), at full opacity. */
export function QueueItems({ items, lastError }: { items: QueueItem[]; lastError?: string }) {
  return (
    <>
      {items.map((q) =>
        q.kind === "message" ? (
          <div key={q.id} className="pt-3">
            <MessageBlock
              from={q.from}
              body={q.body ?? ""}
              urgent={q.urgent}
              queued={{ reason: lastError }}
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
