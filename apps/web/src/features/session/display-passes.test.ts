import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { childrenOf, groupWork, heldSeqs, mergeFailures, runDisplayPasses } from "./display-passes";
import { arrivedSince } from "./jump-pill";
import { buildRows, type Row, stabilizeRows } from "./rows";
import { targetPath, targetRowKey } from "./timeline";

const ev = (seq: number, event: AnyEvent, at = "2026-11-19T19:00:00.000Z"): SessionEvent => ({
  seq,
  agentSlug: "dev",
  turnId: null,
  at,
  event,
});
const unbuilt = (seq: number, at?: string) =>
  ev(
    seq,
    {
      type: "error",
      source: "spawn",
      code: "image_not_built",
      message: "Image `playwright` isn't built",
      fix: "image",
    },
    at,
  );
const rows = (events: SessionEvent[]) => buildRows(events).rows;

test("three adjacent identical failures are one row keyed by the first, with count, lastAt and seqs", () => {
  const raw = rows([
    unbuilt(1, "2026-11-19T19:00:00.000Z"),
    unbuilt(2, "2026-11-19T19:10:00.000Z"),
    unbuilt(3, "2026-11-19T19:32:00.000Z"),
  ]);
  const out = mergeFailures(raw);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    kind: "error",
    key: "1",
    seq: 1,
    count: 3,
    lastAt: "2026-11-19T19:32:00.000Z",
    seqs: [1, 2, 3],
  });
  // Stored rows are untouched.
  expect(raw).toHaveLength(3);
  expect(raw[0]).not.toHaveProperty("count");
});

test("a different row between two failures, or a different code, source or message, never merges", () => {
  expect(
    mergeFailures(
      rows([unbuilt(1), ev(2, { type: "assistant_text", text: "hm" }), unbuilt(3)]),
    ).map((r) => r.key),
  ).toEqual(["1", "2", "3"]);
  const other = (seq: number, o: Record<string, unknown>) =>
    ev(seq, { ...(unbuilt(seq).event as object), ...o } as AnyEvent);
  expect(
    mergeFailures(
      rows([
        unbuilt(1),
        other(2, { code: "other" }),
        other(3, { source: "resume" }),
        other(4, { message: "x" }),
      ]),
    ),
  ).toHaveLength(4);
});

test("a pass with nothing to merge returns its input", () => {
  const raw = rows([unbuilt(1), ev(2, { type: "assistant_text", text: "hm" })]);
  expect(runDisplayPasses(raw)).toBe(raw);
});

test("targetRowKey sends any merged seq to the merged row", () => {
  const merged = mergeFailures(
    rows([ev(1, { type: "assistant_text", text: "a" }), unbuilt(2), unbuilt(3), unbuilt(4)]).concat(
      rows([ev(5, { type: "assistant_text", text: "b" })]),
    ),
  );
  expect(merged.map((r) => r.key)).toEqual(["1", "2", "5"]);
  for (const seq of [2, 3, 4]) expect(targetRowKey(merged, seq)).toBe("2");
});

test("a merged row stays the same object while nothing changes, and a new repeat keeps its key", () => {
  // Events are immutable and kept, as in the session's map: the same objects every build.
  const events = [unbuilt(1), unbuilt(2), unbuilt(3)];
  const first = stabilizeRows([], runDisplayPasses(rows(events.slice(0, 2))));
  const again = stabilizeRows(first, runDisplayPasses(rows(events.slice(0, 2))));
  expect(again[0]).toBe(first[0]);
  const grown = stabilizeRows(first, runDisplayPasses(rows(events)));
  expect(grown.map((r: Row) => r.key)).toEqual(["1"]);
  expect(grown[0]).toMatchObject({ count: 3, seqs: [1, 2, 3] });
});

// groupWork (U3 §9.4): folded tool runs.
type Tool = Extract<Row, { kind: "tool" }>;
const t0 = Date.parse("2026-11-19T19:00:00.000Z");
const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
const tool = (seq: number, name: string, input: unknown, over: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  seq,
  at: iso(seq),
  resultAt: iso(seq + 1),
  call: { type: "tool_call", toolUseId: `tu${seq}`, name, input },
  state: "done",
  children: [],
  key: `${seq}`,
  ...over,
});
const bash = (seq: number, over: Partial<Tool> = {}) =>
  tool(seq, "Bash", { command: `cmd ${seq}` }, over);
const read = (seq: number, path = `f${seq}.ts`, over: Partial<Tool> = {}) =>
  tool(seq, "Read", { file_path: path }, over);
const text = (seq: number): Row => ({
  kind: "text",
  seq,
  at: iso(seq),
  text: "t",
  key: `${seq}`,
  head: false,
});

test("two foldable calls form a group keyed by the first", () => {
  const second = read(5);
  const out = groupWork([bash(3), second]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    kind: "work_group",
    key: "3",
    seq: 3,
    callCount: 2,
    verbsKey: "ran:1,read:1",
  });
  const g = out[0] as Extract<Row, { kind: "work_group" }>;
  // The first child renders under an inner key; the others are the very same rows.
  expect(g.children.map((c) => c.key)).toEqual(["c:3", "5"]);
  expect(g.children[1]).toBe(second);
  expect(childrenOf(g)).toBe(g.children);
});

test("failed, denied, factory, subagent and error rows end a run", () => {
  const denial = {
    type: "permission_denied",
    toolUseId: "tu6",
    toolName: "Bash",
    reason: "no",
  } as Extract<AnyEvent, { type: "permission_denied" }>;
  const outgoing: Row = {
    kind: "outgoing",
    seq: 9,
    at: iso(9),
    call: { type: "tool_call", toolUseId: "tu9", name: "mcp__factory__send_message", input: {} },
    turnOpen: false,
    key: "9",
  };
  const err: Row = {
    kind: "error",
    seq: 13,
    at: iso(13),
    event: { type: "error", source: "api", message: "boom" },
    key: "13",
  };
  const out = groupWork([
    bash(1),
    bash(2, { state: "failed" }),
    bash(3),
    bash(4, { denial }),
    bash(5),
    tool(6, "Agent", { description: "scan" }),
    bash(7),
    outgoing,
    bash(10),
    err,
    bash(14),
    text(15),
  ]);
  expect(out.map((r) => `${r.kind}:${r.key}`)).toEqual([
    "tool:1",
    "tool:2",
    "tool:3",
    "tool:4",
    "tool:5",
    "tool:6",
    "tool:7",
    "outgoing:9",
    "tool:10",
    "error:13",
    "tool:14",
    "text:15",
  ]);
});

test("a run with nothing to fold returns its input; running and no-result calls fold", () => {
  const rows = [bash(1), text(2), bash(3)];
  expect(groupWork(rows)).toBe(rows);
  const out = groupWork([
    text(1),
    bash(2, { state: "running" }),
    read(3, "a", { state: "no_result" }),
    text(4),
  ]);
  expect(out.map((r) => `${r.kind}:${r.key}`)).toEqual(["text:1", "work_group:2", "text:4"]);
});

test("the summary: verbs by family in order of appearance, files counted once, duration from the first call to the last result", () => {
  const out = groupWork([
    read(1, "a.ts"),
    read(2, "a.ts"),
    read(3, "b.ts"),
    bash(4),
    tool(5, "Edit", { file_path: "a.ts" }),
    tool(6, "Grep", { pattern: "x" }),
    bash(7, { resultAt: iso(101) }),
  ]);
  expect(out[0]).toMatchObject({
    kind: "work_group",
    callCount: 7,
    verbsKey: "read:2,ran:2,edited:1,other:1",
    durationMs: 100_000,
  });
  // A last call with no result yet has no duration.
  const running = groupWork([bash(1), bash(2, { state: "running", resultAt: undefined })]);
  expect(running[0]).not.toHaveProperty("durationMs");
});

test("a group is live while it is the newest row and no call lost its turn", () => {
  const footer: Row = { kind: "turn_footer", seq: 9, key: "9", durationMs: 1000, costUsd: 0 };
  expect(groupWork([bash(1), bash(2)])[0]).toMatchObject({ live: true });
  expect(groupWork([bash(1), bash(2), footer])[0]).toMatchObject({ live: false });
  expect(groupWork([bash(1), bash(2), text(3)])[0]).toMatchObject({ live: false });
  expect(groupWork([bash(1), bash(2, { state: "no_result" })])[0]).toMatchObject({ live: false });
});

test("a group keeps its identity through the second stabilization, and a grown group keeps its children", () => {
  const a = bash(1);
  const b = bash(2);
  const first = stabilizeRows([], runDisplayPasses([a, b]));
  const again = stabilizeRows(first, runDisplayPasses([a, b]));
  expect(again[0]).toBe(first[0]);
  const grown = stabilizeRows(first, runDisplayPasses([a, b, bash(3)]));
  const [g0, g1] = [first[0], grown[0]] as Extract<Row, { kind: "work_group" }>[];
  expect(g1).not.toBe(g0);
  expect(g1?.key).toBe("1");
  expect(g1?.children[0]).toBe(g0?.children[0]);
  expect(g1?.children[1]).toBe(g0?.children[1]);
});

test("targetPath descends into a group, the first child included", () => {
  const rows = groupWork([text(1), bash(3), bash(5)]);
  expect(targetPath(rows, 5)).toEqual(["3", "5"]);
  expect(targetPath(rows, 3)).toEqual(["3", "c:3"]);
  expect(targetRowKey(rows, 5)).toBe("3");
});

test("a group holds its calls' seqs, so a call joining it after the reader left counts as new output", () => {
  const [g] = groupWork([bash(3), bash(5), bash(7)]);
  expect(heldSeqs(g as Row)).toEqual([3, 5, 7]);
  expect(arrivedSince([g as Row], 5, new Set())).toEqual({ speech: 0, other: true });
  expect(arrivedSince([g as Row], 7, new Set())).toEqual({ speech: 0, other: false });
});

test("a deep link to a hidden event between a group's calls lands inside the group, on the next call", () => {
  const rows = groupWork([text(1), bash(3), bash(5), text(7)]);
  expect(targetRowKey(rows, 4)).toBe("3");
  expect(targetPath(rows, 4)).toEqual(["3", "5"]);
  expect(targetRowKey(rows, 6)).toBe("7");
});
