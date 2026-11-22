import type { AnyEvent, SessionEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { mergeFailures, runDisplayPasses } from "./display-passes";
import { buildRows, type Row, stabilizeRows } from "./rows";
import { targetRowKey } from "./timeline";

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
