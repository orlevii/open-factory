import type { QueueItem } from "@open-factory/shared";
import { type RawPending, type Row, rawKey } from "./rows";
import { type CancelledEntry, queueView, type SendingBlock } from "./session-state";

type CommandRow = Extract<Row, { kind: "command" }>;

const NO_ROWS: readonly CommandRow[] = [];

/**
 * The raw sends that have no timeline row yet, as rows for the tail of the timeline's items (I1 §5):
 * queued ones (yours get Cancel) then those still sending. Each is keyed `raw:${clientMessageId}`, the
 * key its `operator_input` row gets, so React keeps one node across sending, queued and delivered.
 */
export function rawTailRows(
  queue: QueueItem[],
  sending: readonly SendingBlock[],
  cancelled: ReadonlyMap<string, CancelledEntry>,
  self: string | undefined,
  onCancel: ((item: QueueItem) => void) | undefined,
): readonly CommandRow[] {
  const rows: CommandRow[] = [];
  for (const v of queueView(queue, cancelled)) {
    if (v.kind !== "item" || v.item.kind !== "raw") continue;
    const q = v.item;
    const mine = onCancel !== undefined && self !== undefined && q.from === `@${self}`;
    const pending: RawPending = {
      sending: false,
      ...(mine ? { onCancel: () => onCancel(q) } : {}),
      ...(v.error ? { error: v.error } : {}),
    };
    rows.push({
      kind: "command",
      seq: Number.POSITIVE_INFINITY,
      at: q.createdAt,
      by: q.from,
      text: q.body ?? "",
      key: rawKey(q.clientMessageId ?? q.id),
      pending,
    });
  }
  for (const b of sending) {
    if (!b.raw) continue;
    rows.push({
      kind: "command",
      seq: Number.POSITIVE_INFINITY,
      at: b.at ?? "",
      by: `@${self ?? "you"}`,
      text: b.body,
      key: rawKey(b.clientMessageId),
      pending: { sending: true },
    });
  }
  return rows.length === 0 ? NO_ROWS : rows;
}
