import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { buildRows, deliveryFailedIds } from "./rows";

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
