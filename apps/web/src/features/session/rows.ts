import type { AnyEvent, SessionEvent } from "@open-factory/shared";

type Ev<T extends AnyEvent["type"]> = Extract<AnyEvent, { type: T }>;
export type ToolState = "running" | "done" | "failed" | "no_result";
export type Row =
  | {
      kind: "message";
      seq: number;
      at: string;
      message: Ev<"message_in">["messages"][number];
      key: string;
    }
  | { kind: "text"; seq: number; text: string; key: string }
  | {
      kind: "tool";
      seq: number;
      call: Ev<"tool_call">;
      result?: Ev<"tool_result">;
      truncated?: Record<string, number>;
      state: ToolState;
      children: Row[];
      key: string;
    }
  | { kind: "orphan_result"; seq: number; result: Ev<"tool_result">; key: string }
  | { kind: "compaction"; seq: number; event: Ev<"compacted">; key: string }
  | { kind: "error"; seq: number; event: Ev<"error">; key: string }
  | { kind: "denied"; seq: number; event: Ev<"permission_denied">; key: string }
  | { kind: "quiet"; seq: number; event: AnyEvent; key: string };

const HIDDEN = new Set(["session_started", "turn_started", "usage", "background_tasks"]);

export function deliveryFailedIds(events: SessionEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events)
    if (e.event.type === "delivery_failed") for (const id of e.event.messageIds) out.add(id);
  return out;
}

/** Seqs of errored `turn_end`s whose turn holds a `control{interrupt}` (UI design §4.1: "Turn interrupted"). */
export function interruptedTurnEnds(events: SessionEvent[]): Set<number> {
  const out = new Set<number>();
  let interrupted = false;
  for (const e of events) {
    if (e.event.type === "turn_started") interrupted = false;
    else if (e.event.type === "control" && e.event.cmd === "interrupt") interrupted = true;
    else if (e.event.type === "turn_end") {
      if (e.event.isError && interrupted) out.add(e.seq);
      interrupted = false;
    }
  }
  return out;
}

/** Turn ids that are over (turn_end seen), plus whether anything after a given seq ended all turns. */
function endedTurns(events: SessionEvent[]) {
  const ended = new Set<string>();
  let lastExitSeq = 0;
  let lastTurnStartSeq = 0;
  for (const e of events) {
    if (e.event.type === "turn_end" && e.turnId) ended.add(e.turnId);
    if (e.event.type === "exited") lastExitSeq = e.seq;
    if (e.event.type === "turn_started") lastTurnStartSeq = e.seq;
  }
  return { ended, lastExitSeq, lastTurnStartSeq };
}

export function buildRows(events: SessionEvent[]): Row[] {
  const { ended, lastExitSeq, lastTurnStartSeq } = endedTurns(events);
  const tools = new Map<string, Extract<Row, { kind: "tool" }>>();
  const top: Row[] = [];
  const place = (row: Row, parent?: string) => {
    const p = parent ? tools.get(parent) : undefined;
    (p ? p.children : top).push(row);
  };
  for (const se of events) {
    const e = se.event;
    if (HIDDEN.has(e.type)) continue;
    switch (e.type) {
      case "message_in":
        for (const [i, m] of e.messages.entries()) {
          top.push({
            kind: "message",
            seq: se.seq,
            at: se.at,
            message: m,
            key: `${se.seq}:${i}`,
          });
        }
        break;
      case "assistant_text":
        place({ kind: "text", seq: se.seq, text: e.text, key: `${se.seq}` }, e.parentToolUseId);
        break;
      case "tool_call": {
        const turnOver =
          (se.turnId !== null && ended.has(se.turnId)) ||
          lastExitSeq > se.seq ||
          lastTurnStartSeq > se.seq;
        const row: Extract<Row, { kind: "tool" }> = {
          kind: "tool",
          seq: se.seq,
          call: e,
          state: turnOver ? "no_result" : "running",
          children: [],
          key: `${se.seq}`,
          ...(se.truncated ? { truncated: se.truncated } : {}),
        };
        tools.set(e.toolUseId, row);
        place(row, e.parentToolUseId);
        break;
      }
      case "tool_result": {
        const call = tools.get(e.toolUseId);
        if (!call) {
          place(
            { kind: "orphan_result", seq: se.seq, result: e, key: `${se.seq}` },
            e.parentToolUseId,
          );
          break;
        }
        call.result = e;
        call.state = e.isError ? "failed" : "done";
        if (se.truncated)
          call.truncated = {
            ...call.truncated,
            ...Object.fromEntries(Object.entries(se.truncated).map(([k, v]) => [`result.${k}`, v])),
          };
        break;
      }
      case "compacted":
        top.push({ kind: "compaction", seq: se.seq, event: e, key: `${se.seq}` });
        break;
      case "error":
        top.push({ kind: "error", seq: se.seq, event: e, key: `${se.seq}` });
        break;
      case "permission_denied":
        top.push({ kind: "denied", seq: se.seq, event: e, key: `${se.seq}` });
        break;
      case "turn_end":
        if (e.isError) top.push({ kind: "quiet", seq: se.seq, event: e, key: `${se.seq}` });
        break;
      default:
        top.push({ kind: "quiet", seq: se.seq, event: e, key: `${se.seq}` });
    }
  }
  return top;
}
