import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { childrenOf, runDisplayPasses } from "./display-passes";
import {
  buildRows,
  deliveryFailedIds,
  interruptedTurnEnds,
  isNoticeKind,
  type Row,
  stabilizeRows,
  stableSet,
} from "./rows";

let seq = 0;
const at = "2026-11-18T10:00:00.000Z";
const rowsOf = (evs: SessionEvent[]): Row[] => buildRows(evs).rows;
const e = (event: AnyEvent, turnId: string | null = "t1"): SessionEvent => ({
  seq: ++seq,
  agentSlug: "dev",
  turnId,
  at,
  event,
});

test("hidden types are dropped (a finished turn leaves its footer); text and messages become rows", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "process_started", resumed: false }, null),
    e(
      {
        type: "message_in",
        messages: [
          { id: "m1", from: "@or", kind: "message", urgent: false, body: "a" },
          { id: "m2", from: "@or", kind: "message", urgent: true, body: "b" },
        ],
      },
      null,
    ),
    e(
      { type: "session_started", sessionId: "s", model: "m", cwd: "/", claudeCodeVersion: "x" },
      null,
    ),
    e({ type: "turn_started" }),
    e({ type: "assistant_text", text: "hi" }),
    e({
      type: "usage",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      numTurns: 1,
    }),
    e({ type: "turn_end", isError: false, terminalReason: "completed", numTurns: 1 }),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["quiet", "message", "message", "text", "turn_footer"]);
});

test("a tool call pairs with its result; nested work goes under its parent", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "p", name: "Task", input: { description: "research" } }),
    e({
      type: "tool_call",
      toolUseId: "c",
      name: "Bash",
      input: { command: "ls" },
      parentToolUseId: "p",
    }),
    e({ type: "tool_result", toolUseId: "c", content: "x", isError: false, parentToolUseId: "p" }),
    e({ type: "assistant_text", text: "sub says hi", parentToolUseId: "p" }),
    e({ type: "tool_result", toolUseId: "p", content: "done", isError: false }),
  ]);
  expect(rows).toHaveLength(1);
  const tool = rows[0];
  expect(tool).toMatchObject({ kind: "tool", state: "done" });
  if (tool?.kind !== "tool") throw new Error();
  expect(tool.children.map((c) => c.kind)).toEqual(["tool", "text"]);
});

test("tool state: running while the turn is open; no_result after it ends; failed on isError", () => {
  seq = 0;
  const open = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
  ]);
  expect(open[0]).toMatchObject({ state: "running" });
  const ended = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "turn_end", isError: true, terminalReason: "aborted_tools", numTurns: 1 }),
  ]);
  expect(ended[0]).toMatchObject({ state: "no_result" });
  const exited = rowsOf([
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "exited", code: 1, signal: null, stderrTail: "", expected: false }, null),
  ]);
  expect(exited[0]).toMatchObject({ state: "no_result" });
  const failed = rowsOf([
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "tool_result", toolUseId: "a", content: "no", isError: true }),
  ]);
  expect(failed[0]).toMatchObject({ state: "failed" });
});

test("a result whose call is on an earlier page renders on its own", () => {
  seq = 10;
  expect(
    rowsOf([e({ type: "tool_result", toolUseId: "zz", content: "x", isError: false })])[0],
  ).toMatchObject({ kind: "orphan_result" });
});

test("turn_end renders only when it is an error; delivery_failed ids are collected", () => {
  seq = 0;
  const evs = [
    e({ type: "turn_end", isError: true, terminalReason: "aborted_tools", numTurns: 1 }),
    e({ type: "delivery_failed", messageIds: ["m1", "m2"], reason: "exited" }, null),
  ];
  expect(rowsOf(evs).map((r) => r.kind)).toEqual(["quiet", "quiet"]);
  expect(deliveryFailedIds(evs)).toEqual(new Set(["m1", "m2"]));
});

test("compaction, error and denied events get their own rows", () => {
  seq = 0;
  const rows = rowsOf([
    e({
      type: "compacted",
      trigger: "manual",
      preTokens: 1,
      postTokens: 1,
      durationMs: 1,
    } as never),
    e({ type: "error", message: "bad" } as never),
    e({ type: "permission_denied", toolName: "Bash", reason: "no" } as never),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["compaction", "error", "denied"]);
});

test("truncated fields on a call and its result merge, result fields prefixed", () => {
  seq = 0;
  const call = {
    ...e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    truncated: { "input.command": 5 },
  };
  const res = {
    ...e({ type: "tool_result", toolUseId: "a", content: "x", isError: false }),
    truncated: { content: 9 },
  };
  const [row] = rowsOf([call, res]);
  expect(row).toMatchObject({
    kind: "tool",
    truncated: { "input.command": 5, "result.content": 9 },
  });
});

test("an orphan result with a known parent nests under that parent", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "p", name: "Task", input: {} }),
    e({
      type: "tool_result",
      toolUseId: "gone",
      content: "x",
      isError: false,
      parentToolUseId: "p",
    }),
  ]);
  const parent = rows[0];
  if (parent?.kind !== "tool") throw new Error();
  expect(parent.children.map((c) => c.kind)).toEqual(["orphan_result"]);
});

test("a later turn_started makes an unpaired call no_result", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "turn_started" }, "t1"),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }, "t1"),
    e({ type: "turn_started" }, "t2"),
  ]);
  expect(rows[0]).toMatchObject({ kind: "tool", state: "no_result" });
});

test("interruptedTurnEnds: an errored turn_end after a control interrupt in the same turn", () => {
  seq = 0;
  const events = [
    e({ type: "turn_started" }),
    e({ type: "control", cmd: "interrupt", by: "@or" }),
    e({ type: "turn_end", isError: true, terminalReason: "max_turns", numTurns: 1 }),
    e({ type: "turn_started" }, "t2"),
    e({ type: "turn_end", isError: true, terminalReason: "error", numTurns: 1 }, "t2"),
  ];
  expect([...interruptedTurnEnds(events)]).toEqual([3]);
});

test("a denial whose toolUseId matches a loaded call attaches to it; an unpaired one keeps its row", () => {
  seq = 0;
  const denial = {
    type: "permission_denied",
    toolName: "Read",
    toolUseId: "a",
    reasonType: "rule",
    reason: "no",
  } as const;
  const rows = rowsOf([
    e({ type: "tool_call", toolUseId: "a", name: "Read", input: {} }),
    e(denial),
    e({ type: "tool_result", toolUseId: "a", content: "x", isError: true }),
    e({ ...denial, toolUseId: "elsewhere" }),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["tool", "denied"]);
  const tool = rows[0] as Extract<(typeof rows)[number], { kind: "tool" }>;
  expect(tool.denial).toEqual(denial);
  expect(tool.state).toBe("failed");
});

test("a denial pairs with a nested call too", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "tool_call", toolUseId: "p", name: "Task", input: {} }),
    e({ type: "tool_call", toolUseId: "c", name: "Bash", input: {}, parentToolUseId: "p" }),
    e({
      type: "permission_denied",
      toolName: "Bash",
      toolUseId: "c",
      reasonType: "subcommandResults",
      reason: "",
    }),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["tool"]);
  const child = (rows[0] as Extract<(typeof rows)[number], { kind: "tool" }>).children[0];
  expect(child && "denial" in child && child.denial?.toolUseId).toBe("c");
});

test("spawn_agent and terminate_agent calls with the right shape pair with their results; others fall back", () => {
  seq = 0;
  const spawnInput = { template: "tech-lead", description: "writes the spec", prompt: "Brief" };
  const denial = {
    type: "permission_denied",
    toolName: "mcp__factory__terminate_agent",
    toolUseId: "t2",
    reasonType: "rule",
    reason: "no",
  } as const;
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "s1", name: "mcp__factory__spawn_agent", input: spawnInput }),
    e({
      type: "tool_result",
      toolUseId: "s1",
      content: '{"slug":"tech-lead-ab12"}',
      isError: false,
    }),
    e({
      type: "tool_call",
      toolUseId: "t1",
      name: "mcp__factory__terminate_agent",
      input: { slug: "x" },
    }),
    e({
      type: "tool_call",
      toolUseId: "t2",
      name: "mcp__factory__terminate_agent",
      input: { slug: "y" },
    }),
    e(denial),
    // Wrong shapes: a non-string prompt, a missing slug.
    e({
      type: "tool_call",
      toolUseId: "s2",
      name: "mcp__factory__spawn_agent",
      input: { ...spawnInput, prompt: 1 },
    }),
    e({ type: "tool_call", toolUseId: "t3", name: "mcp__factory__terminate_agent", input: {} }),
    // Nested inside a subagent, it stays nested.
    e({ type: "tool_call", toolUseId: "p", name: "Task", input: {} }),
    e({
      type: "tool_call",
      toolUseId: "s3",
      name: "mcp__factory__spawn_agent",
      input: spawnInput,
      parentToolUseId: "p",
    }),
  ]);
  expect(rows.map((r) => r.kind)).toEqual([
    "spawn",
    "terminate",
    "terminate",
    "tool",
    "tool",
    "tool",
  ]);
  expect(rows[0]).toMatchObject({ kind: "spawn", turnOpen: true, result: { toolUseId: "s1" } });
  expect(rows[1]).toMatchObject({ kind: "terminate", turnOpen: true });
  expect(rows[1] && "result" in rows[1] && rows[1].result).toBeFalsy();
  expect(rows[2]).toMatchObject({ kind: "terminate", denial });
  const task = rows[5] as Extract<(typeof rows)[number], { kind: "tool" }>;
  expect(task.children.map((c) => c.kind)).toEqual(["spawn"]);
});

test("an unanswered spawn after its turn ended is no longer open", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({
      type: "tool_call",
      toolUseId: "s1",
      name: "mcp__factory__spawn_agent",
      input: { template: "dev", description: "d", prompt: "p" },
    }),
    e({ type: "turn_end", isError: false, numTurns: 1 }),
  ]);
  expect(rows).toMatchObject([{ kind: "spawn", turnOpen: false }]);
});

// Stable rows (spec §9.3).
const toolRow = (r: Row | undefined) => {
  if (r?.kind !== "tool") throw new Error("not a tool row");
  return r;
};

test("stabilizing a rebuild of the same events returns the previous array", () => {
  seq = 0;
  const evs = [
    e({ type: "turn_started" }),
    e({ type: "assistant_text", text: "hi" }),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
  ];
  const prev = rowsOf(evs);
  expect(stabilizeRows(prev, rowsOf(evs))).toBe(prev);
  const empty = rowsOf([]);
  expect(stabilizeRows(empty, rowsOf([]))).toBe(empty);
});

test("appending an event reuses every previous row and adds the new one", () => {
  seq = 0;
  const evs = [
    e({ type: "turn_started" }),
    e({ type: "assistant_text", text: "a" }),
    e({ type: "assistant_text", text: "b" }),
  ];
  const prev = rowsOf(evs);
  const next = stabilizeRows(prev, rowsOf([...evs, e({ type: "assistant_text", text: "c" })]));
  expect(next).not.toBe(prev);
  expect(next).toHaveLength(3);
  for (const [i, r] of prev.entries()) expect(next[i]).toBe(r);
  expect(next[2]).toMatchObject({ kind: "text", text: "c" });
});

test("an update_group whose envelopes array is rebuilt with the same elements is reused", () => {
  seq = 0;
  const evs = [
    e(
      {
        type: "message_in",
        messages: [
          { id: "u1", from: "@a", kind: "member_update", urgent: false, body: "x" },
          { id: "u2", from: "@a", kind: "member_update", urgent: false, body: "y" },
        ],
      } as never,
      null,
    ),
  ];
  const prev = rowsOf(evs);
  const next = rowsOf(evs);
  expect(prev[0]?.kind).toBe("update_group");
  expect(next[0]).not.toBe(prev[0]);
  expect(stabilizeRows(prev, next)).toBe(prev);
});

test("a tool row whose truncated object is rebuilt with the same values is reused", () => {
  seq = 0;
  const evs = [
    {
      ...e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
      truncated: { x: 1 } as Record<string, number>,
    },
    {
      ...e({ type: "tool_result", toolUseId: "a", content: "x", isError: false }),
      truncated: { content: 9 },
    },
  ];
  const prev = rowsOf(evs);
  const next = rowsOf(evs);
  expect(toolRow(next[0]).truncated).not.toBe(toolRow(prev[0]).truncated);
  expect(stabilizeRows(prev, next)).toBe(prev);
});

test("a later result, denial or truncated replaces the tool row but keeps its unchanged children", () => {
  seq = 0;
  const base = [
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "p", name: "Task", input: {} }),
    e({ type: "tool_call", toolUseId: "c", name: "Bash", input: {}, parentToolUseId: "p" }),
    e({ type: "tool_result", toolUseId: "c", content: "x", isError: false, parentToolUseId: "p" }),
    e({ type: "assistant_text", text: "sub", parentToolUseId: "p" }),
  ];
  const prev = rowsOf(base);
  const later = [
    e({ type: "tool_result", toolUseId: "p", content: "done", isError: false }),
    e({
      type: "permission_denied",
      toolName: "Task",
      toolUseId: "p",
      reasonType: "rule",
      reason: "no",
    }),
    {
      ...e({ type: "tool_result", toolUseId: "p", content: "done", isError: false }),
      truncated: { content: 3 },
    },
  ];
  for (const ev of later) {
    const next = stabilizeRows(prev, rowsOf([...base, ev]));
    const [was, now] = [toolRow(prev[0]), toolRow(next[0])];
    expect(now).not.toBe(was);
    expect(now.children).toHaveLength(2);
    for (const [i, c] of was.children.entries()) expect(now.children[i]).toBe(c);
  }
  // The replaced rows carry the new fields, not the old ones.
  const withEv = (ev: SessionEvent) => toolRow(stabilizeRows(prev, rowsOf([...base, ev]))[0]);
  expect(withEv(later[0] as SessionEvent).result).toBe(later[0]?.event);
  expect(withEv(later[1] as SessionEvent).denial).toBe(later[1]?.event);
  const t = withEv(later[2] as SessionEvent);
  expect(t.result).toBe(later[2]?.event);
  expect(t.truncated).toEqual({ "result.content": 3 });
});

test("rows whose content really changed are never reused", () => {
  seq = 0;
  // A spawn row whose turn closes after the first build.
  const spawn = e({
    type: "tool_call",
    toolUseId: "s1",
    name: "mcp__factory__spawn_agent",
    input: { template: "tech-lead", description: "d", prompt: "Brief" },
  });
  const open = rowsOf([spawn]);
  const closed = rowsOf([spawn, e({ type: "turn_end", isError: false, numTurns: 1 })]);
  expect(open[0]).toMatchObject({ kind: "spawn", turnOpen: true });
  expect(closed[0]).toMatchObject({ kind: "spawn", turnOpen: false });
  expect(stabilizeRows(open, closed)[0]).not.toBe(open[0]);
  expect(stabilizeRows(open, closed)[0]).toMatchObject({ turnOpen: false });

  // A tool row going running -> no_result.
  const call = e({ type: "tool_call", toolUseId: "b", name: "Bash", input: {} });
  const running = rowsOf([call]);
  const gone = rowsOf([call, e({ type: "turn_end", isError: false, numTurns: 1 })]);
  expect(toolRow(running[0]).state).toBe("running");
  expect(toolRow(gone[0]).state).toBe("no_result");
  expect(stabilizeRows(running, gone)[0]).not.toBe(running[0]);
  expect(stabilizeRows(running, gone)[0]).toMatchObject({ state: "no_result" });

  // An update_group gaining an envelope.
  const env = (id: string) => ({
    id,
    from: "@a",
    kind: "member_update" as const,
    urgent: false,
    body: id,
  });
  const one = e({ type: "message_in", messages: [env("u1")] } as never, null);
  const two = { ...one, event: { ...one.event, messages: [env("u1"), env("u2")] } } as SessionEvent;
  const before = rowsOf([one]);
  const after = rowsOf([two]);
  const grown = stabilizeRows(before, after)[0];
  expect(grown).not.toBe(before[0]);
  expect(grown).toMatchObject({ envelopes: [{ id: "u1" }, { id: "u2" }] });
});

test("stableSet keeps the previous set when the contents are equal", () => {
  const prev = new Set(["a", "b"]);
  expect(stableSet(prev, new Set(prev))).toBe(prev);
  const grown = new Set(["a", "b", "c"]);
  expect(stableSet(prev, grown)).toBe(grown);
  const swapped = new Set(["a", "c"]);
  expect(stableSet(prev, swapped)).toBe(swapped);
  expect(stableSet(undefined, swapped)).toBe(swapped);
});

// Turn footer and the open turn (U3 §5.1, §5.3).
const ts = (): SessionEvent => e({ type: "turn_started" });
const toolCall = (id: string, name = "Bash", input: unknown = { command: "ls" }) =>
  e({ type: "tool_call", toolUseId: id, name, input });
const toolResult = (id: string) =>
  e({ type: "tool_result", toolUseId: id, content: "ok", isError: false });
const usageEv = (durationMs: number, costUsd: number) =>
  e({
    type: "usage",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    durationMs,
    numTurns: 1,
  });
const turnEnd = (over: Partial<Extract<AnyEvent, { type: "turn_end" }>> = {}) =>
  e({ type: "turn_end", isError: false, numTurns: 1, ...over });

test("a non-error turn_end with its usage makes one footer row", () => {
  const rows = rowsOf([ts(), toolCall("a"), toolResult("a"), usageEv(133_000, 0.42), turnEnd()]);
  expect(rows.at(-1)).toMatchObject({
    kind: "turn_footer",
    durationMs: 133_000,
    toolCalls: 1,
    costUsd: 0.42,
  });
  expect(rows.filter((r) => r.kind === "turn_footer")).toHaveLength(1);
});

test("command turns, errored turns and turns without usage have no footer", () => {
  const kinds = (evs: SessionEvent[]) => rowsOf(evs).map((r) => r.kind);
  expect(kinds([ts(), usageEv(1000, 0), turnEnd({ command: "compact" })])).not.toContain(
    "turn_footer",
  );
  expect(kinds([ts(), usageEv(1000, 0), turnEnd({ isError: true })])).toEqual(["quiet"]);
  expect(kinds([ts(), turnEnd()])).toEqual([]);
});

test("toolCalls is omitted when the turn's start isn't loaded", () => {
  const rows = rowsOf([toolCall("a"), usageEv(5000, 0), turnEnd()]);
  const footer = rows.at(-1);
  expect(footer?.kind).toBe("turn_footer");
  expect(footer && "toolCalls" in footer).toBe(false);
});

test("cron and task-notification origins are tagged", () => {
  const origin = (originKind: string) =>
    rowsOf([ts(), usageEv(12_000, 0), turnEnd({ originKind })]).at(-1);
  expect(origin("cron")).toMatchObject({ origin: "cron" });
  expect(origin("task-notification")).toMatchObject({ origin: "task" });
});

test("open tracks the newest unresolved call of the open turn", () => {
  const start = ts();
  const a = toolCall("a");
  const ra = toolResult("a");
  const b = toolCall("b");
  const agent = toolCall("s", "Agent", { description: "dig" });
  const { open } = buildRows([start, a, ra, b, agent]);
  expect(open?.newestOpenTool?.call.toolUseId).toBe("b");
  expect(open?.openSubagents.map((r) => r.call.toolUseId)).toEqual(["s"]);
  expect(buildRows([a, b]).open).toBeUndefined();
  const closed = buildRows([start, toolCall("c"), turnEnd()]).open;
  expect(closed?.newestOpenTool).toBeUndefined();
});

test("a tool row carries when it was called and when its result arrived", () => {
  const [row] = rowsOf([toolCall("a"), toolResult("a")]);
  expect(row).toMatchObject({ kind: "tool", at, resultAt: at });
});

// Speaker lines (U3 §7.2): `head` marks the text rows that open a speaker line.
test("head: a turn's first text, and the first text after a message row in the same turn", () => {
  seq = 0;
  const msg = (id: string) =>
    e(
      {
        type: "message_in",
        messages: [{ id, from: "@or", kind: "message", urgent: false, body: id }],
      },
      null,
    );
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "assistant_text", text: "a" }), // first of turn 1
    e({ type: "assistant_text", text: "b" }),
    msg("m1"),
    e({ type: "assistant_text", text: "c" }), // first after a message, same turn
    e({ type: "assistant_text", text: "d" }),
    e({ type: "turn_end", isError: false, numTurns: 1 }),
    e({ type: "turn_started" }, "t2"),
    e({ type: "assistant_text", text: "e" }, "t2"), // first of turn 2
  ]);
  const heads = rows.flatMap((r) => (r.kind === "text" ? [[r.text, r.head]] : []));
  expect(heads).toEqual([
    ["a", true],
    ["b", false],
    ["c", true],
    ["d", false],
    ["e", true],
  ]);
});

test("head: a turn whose start isn't loaded still heads its first text; a tool row in between doesn't", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "assistant_text", text: "a" }),
    e({ type: "tool_call", toolUseId: "tu", name: "Bash", input: { command: "ls" } }),
    e({ type: "tool_result", toolUseId: "tu", content: "x", isError: false }),
    e({ type: "assistant_text", text: "b" }),
  ]);
  expect(rows.flatMap((r) => (r.kind === "text" ? [r.head] : []))).toEqual([true, false]);
});

test("head: never on a subagent's children, and they don't consume the turn's head", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "ag", name: "Agent", input: {} }),
    e({ type: "assistant_text", text: "inside", parentToolUseId: "ag" }),
    e({ type: "assistant_text", text: "inside 2", parentToolUseId: "ag" }),
    e({ type: "assistant_text", text: "outside" }),
  ]);
  const agent = rows[0];
  if (agent?.kind !== "tool") throw new Error("no agent row");
  expect(agent.children.map((c) => c.kind === "text" && c.head)).toEqual([false, false]);
  expect(rows[1]).toMatchObject({ kind: "text", text: "outside", head: true });
});

// The rows pipeline (U3 §7.7): one helper knows which rows hold children.
test("childrenOf: a tool row's children; none for any other row", () => {
  seq = 0;
  const rows = rowsOf([
    e({ type: "tool_call", toolUseId: "ag", name: "Agent", input: {} }),
    e({ type: "assistant_text", text: "inside", parentToolUseId: "ag" }),
    e({ type: "assistant_text", text: "outside" }),
  ]);
  const [tool, text] = rows;
  if (tool?.kind !== "tool" || !text) throw new Error("rows");
  expect(childrenOf(tool)).toBe(tool.children);
  expect(childrenOf(text)).toEqual([]);
  expect(childrenOf(text)).toBe(childrenOf(text)); // one shared empty array, never a fresh one
});

test("runDisplayPasses keeps every row it doesn't merge (identity in PR2)", () => {
  seq = 0;
  const raw = rowsOf([
    e({ type: "assistant_text", text: "a" }),
    e({ type: "assistant_text", text: "b" }),
  ]);
  const out = runDisplayPasses(raw);
  expect(out).toHaveLength(2);
  for (const [i, r] of out.entries()) expect(r).toBe(raw[i]);
});

test("stabilizeRows recurses through childrenOf: an unchanged nested child keeps its identity", () => {
  seq = 0;
  const evs = [
    e({ type: "tool_call", toolUseId: "ag", name: "Agent", input: {} }),
    e({ type: "assistant_text", text: "inside", parentToolUseId: "ag" }),
  ];
  const first = rowsOf(evs);
  const grown = stabilizeRows(
    first,
    rowsOf([...evs, e({ type: "assistant_text", text: "more", parentToolUseId: "ag" })]),
  );
  const [a, b] = [first[0], grown[0]];
  if (a?.kind !== "tool" || b?.kind !== "tool") throw new Error("rows");
  expect(b).not.toBe(a);
  expect(b.children[0]).toBe(a.children[0]);
});

// Background tasks on their call row (U3 §9.5).
const bgCall = () => [
  e({ type: "tool_call", toolUseId: "tu-bg", name: "Bash", input: { command: "make watch" } }),
  e({ type: "tool_result", toolUseId: "tu-bg", content: "Running in background", isError: false }),
];
const started = (toolUseId?: string) =>
  e({
    type: "background_task_started",
    taskId: "bg1",
    taskType: "local_bash",
    description: "make watch",
    ...(toolUseId ? { toolUseId } : {}),
  });
const finished = (status: string) =>
  e({ type: "background_task_finished", taskId: "bg1", status, summary: "Build ok" });
const toolOf = (rows: Row[]) =>
  rows.find((r) => r.kind === "tool") as Extract<Row, { kind: "tool" }>;

test("a started background task lives on its call row: running, and no quiet line", () => {
  seq = 0;
  const rows = rowsOf([...bgCall(), started("tu-bg")]);
  expect(rows.map((r) => r.kind)).toEqual(["tool"]);
  expect(toolOf(rows).backgroundTask).toEqual({ taskId: "bg1", state: "running" });
});

test("a finished task says finished with its summary; a failed one failed", () => {
  seq = 0;
  const done = rowsOf([...bgCall(), started("tu-bg"), finished("completed")]);
  expect(done.map((r) => r.kind)).toEqual(["tool"]);
  expect(toolOf(done).backgroundTask).toEqual({
    taskId: "bg1",
    state: "finished",
    summary: "Build ok",
  });
  seq = 0;
  const failed = rowsOf([...bgCall(), started("tu-bg"), finished("failed")]);
  expect(toolOf(failed).backgroundTask).toMatchObject({ state: "failed", summary: "Build ok" });
  seq = 0;
  const killed = rowsOf([...bgCall(), started("tu-bg"), finished("killed")]);
  expect(toolOf(killed).backgroundTask).toMatchObject({ state: "stopped", summary: "Build ok" });
});

test("an unmatched task keeps its quiet lines", () => {
  seq = 0;
  const rows = rowsOf([...bgCall(), started(), finished("completed")]);
  expect(rows.map((r) => r.kind)).toEqual(["tool", "quiet", "quiet"]);
  expect(toolOf(rows).backgroundTask).toBeUndefined();
  seq = 0;
  // A toolUseId with no loaded call (a resume, or an earlier page) is unmatched too.
  expect(rowsOf([started("tu-gone"), finished("completed")]).map((r) => r.kind)).toEqual([
    "quiet",
    "quiet",
  ]);
});

test("a later exit with no finish stops the task; a finish before the exit stays", () => {
  seq = 0;
  const exit = () => e({ type: "exited", code: 0, signal: null, expected: true } as AnyEvent, null);
  const stopped = rowsOf([...bgCall(), started("tu-bg"), exit()]);
  expect(toolOf(stopped).backgroundTask).toEqual({ taskId: "bg1", state: "stopped" });
  seq = 0;
  const kept = rowsOf([...bgCall(), started("tu-bg"), finished("completed"), exit()]);
  expect(toolOf(kept).backgroundTask).toMatchObject({ state: "finished" });
});

test("isNoticeKind: factory notices (system, task assigned, task update), never a message or comment", () => {
  expect(["system", "task_assigned", "task_update"].every(isNoticeKind)).toBe(true);
  expect(["message", "task_comment", "scheduled"].some(isNoticeKind)).toBe(false);
});

test("a keyed assistant_text renders under t:<messageId>:<blockIndex>, capped when its text was cut; textHead says whether the next text heads", () => {
  seq = 0;
  const built = buildRows([
    e({ type: "turn_started" }),
    { ...e({ type: "assistant_text", text: "Hi", messageId: "m1", blockIndex: 1 }) },
    {
      ...e({ type: "assistant_text", text: "Long", messageId: "m1", blockIndex: 2 }),
      truncated: { text: 70000 },
    },
    e({ type: "assistant_text", text: "Old" }),
  ]);
  expect(built.rows.map((r) => r.key)).toEqual(["t:m1:1", "t:m1:2", "4"]);
  const [a, b] = built.rows as Extract<Row, { kind: "text" }>[];
  expect(a?.capped).toBeUndefined();
  expect(b?.capped).toBe(true);
  expect(built.textHead).toBe(false);
  expect(buildRows([e({ type: "turn_started" })]).textHead).toBe(true);
  expect(
    buildRows([
      e({ type: "assistant_text", text: "x" }),
      e(
        {
          type: "message_in",
          messages: [{ id: "q", from: "@or", kind: "message", urgent: false, body: "b" }],
        },
        null,
      ),
    ]).textHead,
  ).toBe(true);
});
