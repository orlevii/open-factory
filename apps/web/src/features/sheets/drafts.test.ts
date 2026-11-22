import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { clearDraft, draftGeneration, hasDraft, resetDrafts, useSheetDraft } from "./drafts";

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

test("clearDraft removes one key", () => {
  const a = renderHook(() => useSheetDraft("new-agent", initial));
  act(() => a.result.current.save({ name: "x" }));
  clearDraft("new-agent");
  expect(hasDraft("new-agent")).toBe(false);
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

test("edit drafts keep {values, base} so a server change to an untouched field shows on reopen", async () => {
  const { mergeServer } = await import("./merge-server");
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
