import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { buildRows, deliveryFailedIds, interruptedTurnEnds } from "./rows";

let seq = 0;
const at = "2026-11-18T10:00:00.000Z";
const e = (event: AnyEvent, turnId: string | null = "t1"): SessionEvent => ({
  seq: ++seq,
  agentSlug: "dev",
  turnId,
  at,
  event,
});

test("hidden types are dropped; text and messages become rows", () => {
  seq = 0;
  const rows = buildRows([
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
  expect(rows.map((r) => r.kind)).toEqual(["quiet", "message", "message", "text"]);
});

test("a tool call pairs with its result; nested work goes under its parent", () => {
  seq = 0;
  const rows = buildRows([
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
  const open = buildRows([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
  ]);
  expect(open[0]).toMatchObject({ state: "running" });
  const ended = buildRows([
    e({ type: "turn_started" }),
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "turn_end", isError: true, terminalReason: "aborted_tools", numTurns: 1 }),
  ]);
  expect(ended[0]).toMatchObject({ state: "no_result" });
  const exited = buildRows([
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "exited", code: 1, signal: null, stderrTail: "", expected: false }, null),
  ]);
  expect(exited[0]).toMatchObject({ state: "no_result" });
  const failed = buildRows([
    e({ type: "tool_call", toolUseId: "a", name: "Bash", input: {} }),
    e({ type: "tool_result", toolUseId: "a", content: "no", isError: true }),
  ]);
  expect(failed[0]).toMatchObject({ state: "failed" });
});

test("a result whose call is on an earlier page renders on its own", () => {
  seq = 10;
  expect(
    buildRows([e({ type: "tool_result", toolUseId: "zz", content: "x", isError: false })])[0],
  ).toMatchObject({ kind: "orphan_result" });
});

test("turn_end renders only when it is an error; delivery_failed ids are collected", () => {
  seq = 0;
  const evs = [
    e({ type: "turn_end", isError: true, terminalReason: "aborted_tools", numTurns: 1 }),
    e({ type: "delivery_failed", messageIds: ["m1", "m2"], reason: "exited" }, null),
  ];
  expect(buildRows(evs).map((r) => r.kind)).toEqual(["quiet", "quiet"]);
  expect(deliveryFailedIds(evs)).toEqual(new Set(["m1", "m2"]));
});

test("compaction, error and denied events get their own rows", () => {
  seq = 0;
  const rows = buildRows([
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
  const [row] = buildRows([call, res]);
  expect(row).toMatchObject({
    kind: "tool",
    truncated: { "input.command": 5, "result.content": 9 },
  });
});

test("an orphan result with a known parent nests under that parent", () => {
  seq = 0;
  const rows = buildRows([
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
  const rows = buildRows([
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
  const rows = buildRows([
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
  const rows = buildRows([
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
  const rows = buildRows([
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
  const rows = buildRows([
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
