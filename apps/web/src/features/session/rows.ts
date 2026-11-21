import type { AnyEvent, Envelope, SessionEvent } from "@open-factory/shared";

type Ev<T extends AnyEvent["type"]> = Extract<AnyEvent, { type: T }>;
export type ToolState = "running" | "done" | "failed" | "no_result";
/** A factory tool call shown as its own block or line, paired with its result by `toolUseId`. */
type FactoryCall = {
  seq: number;
  at: string;
  call: Ev<"tool_call">;
  result?: Ev<"tool_result">;
  /** The call's turn is still open (no result yet means "Sending…"/"Spawning…", else no result). */
  turnOpen: boolean;
  /** A `permission_denied` for this call; it shows as the failure. */
  denial?: Ev<"permission_denied">;
  key: string;
};
export type Row =
  | {
      kind: "message";
      seq: number;
      at: string;
      message: Ev<"message_in">["messages"][number];
      key: string;
    }
  | {
      kind: "update_group";
      seq: number;
      at: string;
      about: string;
      envelopes: Envelope[];
      key: string;
    }
  | { kind: "peer"; seq: number; envelope: Envelope; key: string }
  | ({ kind: "outgoing" } & FactoryCall)
  /** `spawn_agent` (S7 UI design §4.1). */
  | ({ kind: "spawn" } & FactoryCall)
  /** `terminate_agent` (S7 UI design §4.2). */
  | ({ kind: "terminate" } & FactoryCall)
  | { kind: "text"; seq: number; text: string; key: string }
  | {
      kind: "tool";
      seq: number;
      /** When the call was made, and when its result arrived. */
      at: string;
      resultAt?: string;
      call: Ev<"tool_call">;
      result?: Ev<"tool_result">;
      truncated?: Record<string, number>;
      state: ToolState;
      /** A `permission_denied` for this call (UI design §4.4): it renders inside the call's row. */
      denial?: Ev<"permission_denied">;
      children: Row[];
      key: string;
    }
  | { kind: "orphan_result"; seq: number; result: Ev<"tool_result">; key: string }
  | { kind: "compaction"; seq: number; event: Ev<"compacted">; key: string }
  | { kind: "error"; seq: number; event: Ev<"error">; key: string }
  | { kind: "denied"; seq: number; event: Ev<"permission_denied">; key: string }
  | { kind: "quiet"; seq: number; event: AnyEvent; key: string }
  /** "Worked 2m 13s · 14 tool calls · $0.42 est." after a finished turn (U3 §5.3). */
  | {
      kind: "turn_footer";
      seq: number;
      key: string;
      durationMs: number;
      /** Omitted when the turn's start isn't loaded (the count would understate). */
      toolCalls?: number;
      costUsd: number;
      /** A self-started turn: a background task finished, or a cron fired. */
      origin?: "task" | "cron";
    };

/** The open turn's rows, from the events after the newest `turn_started` (U3 §5.1). */
export type OpenTurnRows = { newestOpenTool?: ToolRow; openSubagents: ToolRow[] };

// `rate_limited` renders nothing from S5 on: `rate_limit_paused` is the one line for that moment.
const HIDDEN = new Set([
  "session_started",
  "turn_started",
  "usage",
  "background_tasks",
  "rate_limited",
  "rate_limit_status",
]);

/** Events with no line of their own in context (S5 UI design §3.3). */
function silent(e: AnyEvent, prev: Row | undefined): boolean {
  if (e.type === "container") return e.action === "started";
  if (e.type === "cleanup") return !e.container && !e.killedProcesses;
  // The session_reset row already says a new session started; a spawned agent's first start is
  // the `spawned` line's.
  if (e.type === "process_started")
    return (
      e.reason === "reset" ||
      e.reason === "spawned" ||
      (prev?.kind === "quiet" && prev.event.type === "session_reset")
    );
  return false;
}

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

export const SEND_MESSAGE_TOOL = "mcp__factory__send_message";

/** A `send_message` call with a string `to` and `body` renders as an outgoing message; any other
 *  shape falls back to the generic tool row (UI design §2.5). */
export function isSendMessageCall(e: Ev<"tool_call">): boolean {
  if (e.name !== SEND_MESSAGE_TOOL) return false;
  const i = e.input as Record<string, unknown> | null;
  return !!i && typeof i.to === "string" && typeof i.body === "string";
}

export const SPAWN_AGENT_TOOL = "mcp__factory__spawn_agent";
export const TERMINATE_AGENT_TOOL = "mcp__factory__terminate_agent";

const isStr = (v: unknown) => typeof v === "string";

/** Which factory block a call renders as; any other shape falls back to the generic tool row
 *  (S6 UI design §2.5, S7 UI design §4.1-§4.2). */
function factoryKind(e: Ev<"tool_call">): "outgoing" | "spawn" | "terminate" | undefined {
  if (isSendMessageCall(e)) return "outgoing";
  const i = e.input as Record<string, unknown> | null;
  if (!i) return undefined;
  if (e.name === SPAWN_AGENT_TOOL && isStr(i.template) && isStr(i.description) && isStr(i.prompt))
    return "spawn";
  if (e.name === TERMINATE_AGENT_TOOL && isStr(i.slug)) return "terminate";
  return undefined;
}

export type ToolRow = Extract<Row, { kind: "tool" }>;
type FactoryRow = Extract<Row, { kind: "outgoing" | "spawn" | "terminate" }>;

/** Consecutive `member_update` envelopes about one agent become one group; peer events and
 *  everything else stand alone (UI design §2.2). */
function messageRows(se: SessionEvent, messages: Envelope[]): Row[] {
  const out: Row[] = [];
  for (const [i, m] of messages.entries()) {
    const key = `${se.seq}:${i}`;
    if (m.kind === "member_update") {
      const about = m.about ?? m.from;
      const last = out.at(-1);
      if (last?.kind === "update_group" && last.about === about) last.envelopes.push(m);
      else out.push({ kind: "update_group", seq: se.seq, at: se.at, about, envelopes: [m], key });
    } else if (m.kind === "peer_joined" || m.kind === "peer_left") {
      out.push({ kind: "peer", seq: se.seq, envelope: m, key });
    } else out.push({ kind: "message", seq: se.seq, at: se.at, message: m, key });
  }
  return out;
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export function buildRows(events: SessionEvent[]): { rows: Row[]; open: OpenTurnRows | undefined } {
  const { ended, lastExitSeq, lastTurnStartSeq } = endedTurns(events);
  const tools = new Map<string, ToolRow>();
  const outgoing = new Map<string, FactoryRow>();
  const top: Row[] = [];
  const place = (row: Row, parent?: string) => {
    const p = parent ? tools.get(parent) : undefined;
    (p ? p.children : top).push(row);
  };
  // The current turn's facts for its footer; `started` is false until its `turn_started` is loaded.
  let started = false;
  let calls = 0;
  let usage: Ev<"usage"> | undefined;
  let hasOpenStart = false;
  for (const se of events) {
    const e = se.event;
    if (e.type === "turn_started") {
      started = true;
      hasOpenStart = true;
      calls = 0;
      usage = undefined;
    } else if (e.type === "tool_call") calls++;
    else if (e.type === "usage") usage = e;
    if (HIDDEN.has(e.type) || silent(e, top.at(-1))) continue;
    switch (e.type) {
      case "message_in":
        top.push(...messageRows(se, e.messages));
        break;
      case "assistant_text":
        place({ kind: "text", seq: se.seq, text: e.text, key: `${se.seq}` }, e.parentToolUseId);
        break;
      case "tool_call": {
        const turnOver =
          (se.turnId !== null && ended.has(se.turnId)) ||
          lastExitSeq > se.seq ||
          lastTurnStartSeq > se.seq;
        const kind = factoryKind(e);
        if (kind) {
          const out: FactoryRow = {
            kind,
            seq: se.seq,
            at: se.at,
            call: e,
            turnOpen: !turnOver,
            key: `${se.seq}`,
          };
          outgoing.set(e.toolUseId, out);
          place(out, e.parentToolUseId);
          break;
        }
        const row: ToolRow = {
          kind: "tool",
          seq: se.seq,
          at: se.at,
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
        const sent = outgoing.get(e.toolUseId);
        if (sent) {
          sent.result = e;
          break;
        }
        const call = tools.get(e.toolUseId);
        if (!call) {
          place(
            { kind: "orphan_result", seq: se.seq, result: e, key: `${se.seq}` },
            e.parentToolUseId,
          );
          break;
        }
        call.result = e;
        call.resultAt = se.at;
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
      case "permission_denied": {
        const sent = outgoing.get(e.toolUseId);
        if (sent) {
          sent.denial = e;
          break;
        }
        const call = tools.get(e.toolUseId);
        if (call) call.denial = e;
        else top.push({ kind: "denied", seq: se.seq, event: e, key: `${se.seq}` });
        break;
      }
      case "turn_end":
        if (e.isError) top.push({ kind: "quiet", seq: se.seq, event: e, key: `${se.seq}` });
        else if (!e.command && usage) {
          top.push({
            kind: "turn_footer",
            seq: se.seq,
            key: `${se.seq}`,
            durationMs: usage.durationMs,
            ...(started ? { toolCalls: calls } : {}),
            costUsd: usage.costUsd,
            ...(e.originKind === "task-notification"
              ? { origin: "task" as const }
              : e.originKind === "cron"
                ? { origin: "cron" as const }
                : {}),
          });
        }
        started = false;
        calls = 0;
        usage = undefined;
        break;
      default:
        top.push({ kind: "quiet", seq: se.seq, event: e, key: `${se.seq}` });
    }
  }
  if (!hasOpenStart) return { rows: top, open: undefined };
  const open: OpenTurnRows = { openSubagents: [] };
  for (const row of tools.values()) {
    if (row.seq <= lastTurnStartSeq || row.state !== "running") continue;
    if (SUBAGENT_TOOLS.has(row.call.name)) open.openSubagents.push(row);
    else if (!open.newestOpenTool || row.seq > open.newestOpenTool.seq) open.newestOpenTool = row;
  }
  return { rows: top, open };
}

/** `open` rebuilt over the stabilized rows (by key), and the previous object when nothing changed, so
 *  the activity line sees the same `ToolRow`s the timeline renders (U3 §5.1). */
export function stabilizeOpen(
  prev: OpenTurnRows | undefined,
  open: OpenTurnRows | undefined,
  rows: readonly Row[],
): OpenTurnRows | undefined {
  if (!open) return undefined;
  const byKey = new Map<string, ToolRow>();
  const walk = (list: readonly Row[]) => {
    for (const r of list)
      if (r.kind === "tool") {
        byKey.set(r.key, r);
        walk(r.children);
      }
  };
  walk(rows);
  const pick = (r: ToolRow) => byKey.get(r.key) ?? r;
  const next: OpenTurnRows = {
    ...(open.newestOpenTool ? { newestOpenTool: pick(open.newestOpenTool) } : {}),
    openSubagents: open.openSubagents.map(pick),
  };
  if (
    prev &&
    prev.newestOpenTool === next.newestOpenTool &&
    prev.openSubagents.length === next.openSubagents.length &&
    prev.openSubagents.every((r, i) => r === next.openSubagents[i])
  )
    return prev;
  return next;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** Event objects are compared by identity (immutable, kept in the map); arrays element by element; plain
 *  objects (a tool's `truncated`) shallowly. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => x === b[i]);
  if (isPlainObject(a) && isPlainObject(b) && !("type" in a)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
  }
  return false;
}

/** Children first (spec §9.3): a tool row whose result, denial or `truncated` arrives later is a new
 *  object, but it still carries its stabilized children, so unchanged child rows keep their identity.
 *  A seq repeated within one batch is inserted once upstream (Task 29), so keys are unique here. */
function stabilizeRow(old: Row, row: Row): Row {
  if (old === row) return old;
  if (old.kind !== row.kind) return row;
  let base = row;
  if (row.kind === "tool" && old.kind === "tool") {
    const children = stabilizeRows(old.children, row.children);
    if (children !== row.children) base = { ...row, children };
  }
  const o = old as Record<string, unknown>;
  const r = base as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== Object.keys(o).length) return base;
  for (const k of keys) if (!sameValue(o[k], r[k])) return base;
  return old;
}

/** Reuses the previous row object for every unchanged row, so memoized rows skip rendering (spec §9.3). */
export function stabilizeRows(prev: readonly Row[], next: Row[]): Row[] {
  if (prev.length === 0) return next.length === 0 ? (prev as Row[]) : next;
  const byKey = new Map(prev.map((r) => [r.key, r]));
  let same = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = byKey.get(row.key);
    const s = old ? stabilizeRow(old, row) : row;
    if (s !== prev[i]) same = false;
    return s;
  });
  return same ? (prev as Row[]) : out;
}

/** The previous set when the contents are equal, so consumers comparing by identity skip work. */
export function stableSet<T>(
  prev: ReadonlySet<T> | undefined,
  next: ReadonlySet<T>,
): ReadonlySet<T> {
  if (prev && prev.size === next.size) {
    for (const x of next) if (!prev.has(x)) return next;
    return prev;
  }
  return next;
}
