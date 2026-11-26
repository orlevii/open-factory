import type { QueueItem } from "@open-factory/shared";
import { type RawPending, type Row, rawKey } from "./rows";
import { type CancelledEntry, queueView, type SendingBlock } from "./session-state";

type CommandRow = Extract<Row, { kind: "command" }>;

/** A send without a time sorts after every timestamp. */
const LAST = "\uffff";
const NO_ROWS: readonly CommandRow[] = [];

/**
 * The raw sends that have no timeline row yet, as rows for the tail of the timeline's items (I1 §5):
 * the queued ones (yours get Cancel) and those still sending, oldest first. Each is keyed `raw:${clientMessageId}`, the
 * key its `operator_input` row gets, so React keeps one node across sending, queued and delivered.
 */
export function rawTailRows(
  queue: QueueItem[],
  sending: readonly SendingBlock[],
  cancelled: ReadonlyMap<string, CancelledEntry>,
  /** The signed-in human's tag: their own queued sends are the ones with Cancel. */
  selfTag: string | undefined,
  onCancel: ((item: QueueItem) => void) | undefined,
): readonly CommandRow[] {
  const rows: CommandRow[] = [];
  for (const v of queueView(queue, cancelled)) {
    if (v.kind !== "item" || v.item.kind !== "raw") continue;
    const q = v.item;
    const mine = onCancel !== undefined && selfTag !== undefined && q.from === selfTag;
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
      fromKind: q.fromKind === "agent" ? "agent" : "human",
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
      by: selfTag ?? "you",
      fromKind: "human",
      text: b.body,
      key: rawKey(b.clientMessageId),
      pending: { sending: true },
    });
  }
  if (rows.length === 0) return NO_ROWS;
  // Two quick sends can answer out of order: the later one's 202 must not put it above the earlier.
  return rows.length > 1
    ? rows.toSorted((a, b) => (a.at || LAST).localeCompare(b.at || LAST))
    : rows;
}
