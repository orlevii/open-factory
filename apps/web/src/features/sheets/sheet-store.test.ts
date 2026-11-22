import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  closeChildSheet,
  closeSheet,
  completeChild,
  getSheetState,
  openChildSheet,
  openSheet,
  resetSheets,
  setPathnameSource,
  useSheet,
} from "./sheet-store";

beforeEach(() => resetSheets());
const childId = () => getSheetState().child?.id ?? -1;

test("openSheet records the pathname it belongs to", () => {
  setPathnameSource(() => "/tasks");
  openSheet({ kind: "new-task" });
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", at: "/tasks", instant: false });
  openSheet({ kind: "new-agent" }, { at: "/agents", instant: true });
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent", at: "/agents", instant: true });
});

test("opening while open swaps in place and keeps one parent; each open gets a fresh id", () => {
  openSheet({ kind: "new-task" });
  const a = getSheetState().parent?.id;
  openSheet({ kind: "new-schedule" });
  expect(getSheetState().parent?.id).not.toBe(a);
});

test("a child needs a parent (throws in tests) and there is never more than one", () => {
  expect(() => openChildSheet({ kind: "add-credential" }, () => {})).toThrow();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-credential" }, () => {});
  openChildSheet({ kind: "add-project" }, () => {});
  expect(getSheetState().child).toMatchObject({ kind: "add-project" });
});

test("a child completes into its parent's callback and closes", () => {
  const done = vi.fn();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-credential" }, done);
  completeChild(childId(), "prod");
  expect(done).toHaveBeenCalledWith("prod");
  expect(getSheetState().child).toBeUndefined();
});

test("a late child result reaches only the parent instance that opened it", () => {
  const done = vi.fn();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-credential" }, done);
  const cid = childId();
  closeSheet();
  openSheet({ kind: "new-agent" });
  completeChild(cid, "prod");
  expect(done).not.toHaveBeenCalled();
});

test("closeSheet closes both; resetSheets drops pending callbacks", () => {
  const done = vi.fn();
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-project" }, done);
  const cid = childId();
  closeChildSheet();
  expect(getSheetState().child).toBeUndefined();
  expect(getSheetState().parent).toBeDefined();
  openChildSheet({ kind: "add-project" }, done);
  closeSheet();
  expect(getSheetState()).toEqual({});
  openSheet({ kind: "new-agent" });
  openChildSheet({ kind: "add-project" }, done);
  const id2 = childId();
  resetSheets();
  expect(getSheetState()).toEqual({});
  completeChild(cid, "x");
  completeChild(id2, "x");
  expect(done).not.toHaveBeenCalled();
});

test("child keeps the same parent reference; state is stable between reads", () => {
  openSheet({ kind: "new-agent" });
  const parent = getSheetState().parent;
  openChildSheet({ kind: "add-project" }, () => {});
  expect(getSheetState().parent).toBe(parent);
  expect(getSheetState()).toBe(getSheetState());
});

test("useSheet re-renders subscribers on change only", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useSheet();
  });
  const base = renders;
  act(() => closeSheet());
  expect(renders).toBe(base);
  act(() => openSheet({ kind: "new-task" }));
  expect(result.current.parent).toMatchObject({ kind: "new-task" });
  expect(renders).toBe(base + 1);
});
