import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import {
  clearDraft,
  clearDraftIf,
  draftGeneration,
  hasDraft,
  peekDraft,
  resetDrafts,
  useSheetDraft,
} from "./drafts";
import { mergeServer } from "./merge-server";

beforeEach(() => resetDrafts());
const initial = () => ({ name: "" });

test("a saved draft is the next instance's start", () => {
  const a = renderHook(() => useSheetDraft("new-task", initial));
  expect(a.result.current.restored).toBe(false);
  act(() => a.result.current.save({ name: "x" }));
  const b = renderHook(() => useSheetDraft("new-task", initial));
  expect(b.result.current.start).toEqual({ name: "x" });
  expect(b.result.current.restored).toBe(true);
});

test("clear makes the next start come from initial", () => {
  const a = renderHook(() => useSheetDraft("new-task", initial));
  act(() => a.result.current.save({ name: "x" }));
  act(() => a.result.current.clear());
  const b = renderHook(() => useSheetDraft("new-task", initial));
  expect(b.result.current.start).toEqual({ name: "" });
  expect(b.result.current.restored).toBe(false);
});

test("resetDrafts clears every key and bumps the generation", () => {
  const a = renderHook(() => useSheetDraft("new-task", initial));
  const b = renderHook(() => useSheetDraft("edit-agent:x", initial));
  act(() => a.result.current.save({ name: "1" }));
  act(() => b.result.current.save({ name: "2" }));
  const g = draftGeneration();
  resetDrafts();
  expect(hasDraft("new-task")).toBe(false);
  expect(hasDraft("edit-agent:x")).toBe(false);
  expect(draftGeneration()).toBe(g + 1);
});

test("saving a value equal to initial deletes the draft", () => {
  const a = renderHook(() => useSheetDraft("new-agent", initial));
  act(() => a.result.current.save({ name: "x" }));
  expect(hasDraft("new-agent")).toBe(true);
  act(() => a.result.current.save({ name: "" }));
  expect(hasDraft("new-agent")).toBe(false);
  expect(renderHook(() => useSheetDraft("new-agent", initial)).result.current.restored).toBe(false);
});

test("rebase makes the given values the untouched baseline", () => {
  const a = renderHook(() => useSheetDraft("new-task", () => ({ name: "stale" })));
  act(() => a.result.current.rebase({ name: "" }));
  act(() => a.result.current.save({ name: "" }));
  expect(hasDraft("new-task")).toBe(false);
  act(() => a.result.current.save({ name: "x" }));
  expect(hasDraft("new-task")).toBe(true);
});

test("clearDraft removes one key", () => {
  const a = renderHook(() => useSheetDraft("new-agent", initial));
  act(() => a.result.current.save({ name: "x" }));
  clearDraft("new-agent");
  expect(hasDraft("new-agent")).toBe(false);
});

test("clearDraftIf clears only a draft that still equals the snapshot", () => {
  const a = renderHook(() => useSheetDraft("new-task", initial));
  act(() => a.result.current.save({ name: "sent" }));
  const snapshot = peekDraft("new-task");
  expect(snapshot).toEqual({ name: "sent" });
  // Edited since: kept.
  act(() => a.result.current.save({ name: "sent, then edited" }));
  expect(clearDraftIf("new-task", snapshot)).toBe(false);
  expect(peekDraft("new-task")).toEqual({ name: "sent, then edited" });
  // Back to the sent values: cleared.
  act(() => a.result.current.save({ name: "sent" }));
  expect(clearDraftIf("new-task", snapshot)).toBe(true);
  expect(hasDraft("new-task")).toBe(false);
  // No draft, or no snapshot: nothing to clear.
  expect(clearDraftIf("new-task", snapshot)).toBe(false);
  act(() => a.result.current.save({ name: "y" }));
  expect(clearDraftIf("new-task", undefined)).toBe(false);
  expect(hasDraft("new-task")).toBe(true);
});

test("peekDraft is a copy, not the stored reference", () => {
  const a = renderHook(() => useSheetDraft("new-task", () => ({ list: [] as string[] })));
  act(() => a.result.current.save({ list: ["a"] }));
  (peekDraft("new-task") as { list: string[] }).list.push("b");
  expect(peekDraft("new-task")).toEqual({ list: ["a"] });
});

test("initial runs once, save and clear keep their identity, saving does not re-render", () => {
  let calls = 0;
  let renders = 0;
  const h = renderHook(() => {
    renders++;
    return useSheetDraft("new-schedule", () => {
      calls++;
      return { name: "" };
    });
  });
  const { save, clear } = h.result.current;
  h.rerender();
  expect(h.result.current.save).toBe(save);
  expect(h.result.current.clear).toBe(clear);
  const before = renders;
  act(() => save({ name: "x" }));
  expect(renders).toBe(before);
  h.rerender();
  expect(calls).toBe(1);
});

test("edit drafts keep {values, base} so a server change to an untouched field shows on reopen", () => {
  type V = { a: string; b: string };
  const base: V = { a: "1", b: "2" };
  const h = renderHook(() =>
    useSheetDraft<{ values: V; base: V }>("edit-agent:s", () => ({ values: base, base })),
  );
  act(() => h.result.current.save({ values: { ...base, a: "mine" }, base }));
  const re = renderHook(() =>
    useSheetDraft<{ values: V; base: V }>("edit-agent:s", () => ({ values: base, base })),
  );
  const d = re.result.current.start;
  expect(mergeServer(d.values, d.base, { a: "1", b: "S" })).toEqual({ a: "mine", b: "S" });
});

type EV = { a: string };
const editInit = (server: EV) => () => ({ values: server, base: server });

test("an untouched edit form saving against a newer server copy is no draft", () => {
  const h = renderHook(() => useSheetDraft("edit-agent:u", editInit({ a: "1" })));
  act(() => h.result.current.save({ values: { a: "2" }, base: { a: "2" } }));
  expect(hasDraft("edit-agent:u")).toBe(false);
});

test("a new key restarts from that key's draft or initial", () => {
  const seed = renderHook(() => useSheetDraft("edit-agent:b", editInit({ a: "1" })));
  act(() => seed.result.current.save({ values: { a: "mine" }, base: { a: "1" } }));
  const h = renderHook(
    ({ k }: { k: "edit-agent:a" | "edit-agent:b" }) => useSheetDraft(k, editInit({ a: "1" })),
    {
      initialProps: { k: "edit-agent:a" },
    },
  );
  expect(h.result.current.restored).toBe(false);
  h.rerender({ k: "edit-agent:b" });
  expect(h.result.current.restored).toBe(true);
  expect(h.result.current.start.values.a).toBe("mine");
});

test("start is a copy, not the stored reference", () => {
  const a = renderHook(() => useSheetDraft("new-task", initial));
  act(() => a.result.current.save({ name: "x" }));
  const b = renderHook(() => useSheetDraft("new-task", initial));
  b.result.current.start.name = "mutated";
  expect(renderHook(() => useSheetDraft("new-task", initial)).result.current.start.name).toBe("x");
});
