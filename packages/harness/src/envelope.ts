import type { Envelope, MessageKind } from "@open-factory/shared";
import type { FactoryMessage } from "./types.ts";

const attr = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Any spelling of an opening or closing factory-message tag (case, inner spaces). */
const TAG = /<(\s*\/?\s*)factory-message/gi;

/** Only the envelope tag is neutralised in a body; everything else reaches the model unchanged. */
const body = (s: string) => s.replace(TAG, "&lt;$1factory-message");

/** Bodies are already escaped (groupEnvelopes is the one owner), so this writes `m.body` as given. */
function one(m: FactoryMessage): string {
  const id = m.ids && m.ids.length > 1 ? `ids="${attr(m.ids.join(" "))}"` : `id="${attr(m.id)}"`;
  const about = m.about ? ` about="${attr(m.about)}"` : "";
  const task = m.taskKey ? ` task="${attr(m.taskKey)}"` : "";
  return (
    `<factory-message from="${attr(m.from)}" kind="${m.kind}" urgent="${m.urgent}" ${id}${about}${task}>\n` +
    `${m.body}\n</factory-message>`
  );
}

/** One user turn: the envelopes in order, separated by a blank line (Message concept). */
export function renderEnvelopes(messages: FactoryMessage[]): string {
  return messages.map(one).join("\n\n");
}

export const QUOTE_CAP = 2000;

/**
 * Quotes reported text (spec §9.2): capped, envelope tags neutralised with the same helper the envelope uses, every
 * line prefixed. The neutralising is idempotent, so groupEnvelopes escaping the stored body again changes nothing.
 */
export function quoteReported(intro: string, text: string): string {
  const capped = body(text.length > QUOTE_CAP ? `${text.slice(0, QUOTE_CAP)}[truncated]` : text);
  return [intro, ...capped.split("\n").map((l) => `> ${l}`)].join("\n");
}

export type BatchRow = {
  id: string;
  kind: MessageKind;
  from: string;
  urgent: boolean;
  body: string;
  createdAt: Date;
  about?: string;
  /** The report's slug for member updates. */
  groupKey?: string;
  fact?: string;
  subject?: NonNullable<Envelope["subject"]>;
  /** S8: the task a task message is about. */
  taskKey?: string;
  taskTitle?: string;
  commentId?: string;
};

const ORDER: Record<MessageKind, number> = {
  system: 0,
  message: 1,
  member_update: 2,
  peer_joined: 3,
  peer_left: 3,
  // S8: task messages are direct messages; they sort with `message`, in created order.
  task_assigned: 1,
  task_comment: 1,
  task_update: 1,
};

const part = (r: BatchRow) => ({ id: r.id, body: r.body, createdAt: r.createdAt.toISOString() });

const taskFields = (r: BatchRow) => ({
  ...(r.taskKey ? { taskKey: r.taskKey } : {}),
  ...(r.taskTitle ? { taskTitle: r.taskTitle } : {}),
  ...(r.commentId ? { commentId: r.commentId } : {}),
});

function single(r: BatchRow): FactoryMessage {
  return {
    id: r.id,
    from: r.from,
    kind: r.kind,
    urgent: r.urgent,
    body: body(r.body),
    ...(r.about ? { about: r.about } : {}),
    ...(r.fact ? { fact: r.fact } : {}),
    ...(r.subject ? { subject: r.subject } : {}),
    ...taskFields(r),
    parts: [part(r)],
  };
}

function merge(run: BatchRow[]): FactoryMessage {
  const [first] = run as [BatchRow, ...BatchRow[]];
  if (run.length === 1) return single(first);
  return {
    id: first.id,
    ids: run.map((r) => r.id),
    from: first.from,
    kind: first.kind,
    urgent: run.some((r) => r.urgent),
    body: run.map((r) => body(r.body)).join("\n\n"),
    ...(first.about ? { about: first.about } : {}),
    ...(first.fact ? { fact: first.fact } : {}),
    ...(first.subject ? { subject: first.subject } : {}),
    ...taskFields(first),
    parts: run.map(part),
  };
}

/** Rows merge only when everything the envelope carries besides the body is the same (sender, about, fact, subject). */
const runKey = (r: BatchRow) =>
  JSON.stringify([r.from, r.about ?? null, r.fact ?? null, r.subject ?? null, r.taskKey ?? null]);

/** Builds every batch: notices, messages, member-update groups (merged per consecutive sender), then peer events. */
export function groupEnvelopes(rows: BatchRow[]): FactoryMessage[] {
  const byTime = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const bucket = (k: number) => byTime.filter((r) => ORDER[r.kind] === k);
  const updates = bucket(2);
  const groupOrder: string[] = [];
  for (const r of updates) {
    const g = r.groupKey ?? r.from;
    if (!groupOrder.includes(g)) groupOrder.push(g);
  }
  const out: FactoryMessage[] = [...bucket(0), ...bucket(1)].map(single);
  for (const g of groupOrder) {
    let run: BatchRow[] = [];
    const flushRun = () => {
      if (run.length) out.push(merge(run));
      run = [];
    };
    for (const r of updates.filter((u) => (u.groupKey ?? u.from) === g)) {
      if (run[0] && runKey(run[0]) !== runKey(r)) flushRun();
      run.push(r);
    }
    flushRun();
  }
  out.push(...bucket(3).map(single));
  return out;
}
