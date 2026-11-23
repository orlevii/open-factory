import { act, renderHook } from "@testing-library/react";
import type { FocusEvent } from "react";
import { expect, test } from "vitest";
import { useHeldList } from "./use-held-list";

type Row = { id: string; n: number; read?: boolean };
const keyOf = (r: Row) => r.id;
const gone = (r: Row): Row => ({ ...r, n: 0, read: true });
const row = (id: string, n = 1): Row => ({ id, n });
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);
const leaving = (to: Node | null) =>
  ({ currentTarget: document.body, relatedTarget: to }) as unknown as FocusEvent;

function setup(first: Row[]) {
  const view = renderHook(({ live }) => useHeldList(live, keyOf, gone), {
    initialProps: { live: first },
  });
  return { ...view, set: (live: Row[]) => view.rerender({ live }) };
}

test("not held, the list is the live one", () => {
  const h = setup([row("a"), row("b")]);
  h.set([row("c"), row("a")]);
  expect(ids(h.result.current.rows)).toEqual(["c", "a"]);
  expect(h.result.current.held).toBe(false);
});

test("held by the pointer: a removal, a re-sort and an insertion wait; data stays live", () => {
  const h = setup([row("a", 1), row("b", 2), row("c", 3)]);
  act(() => h.result.current.handlers.onPointerEnter());
  expect(h.result.current.held).toBe(true);
  // b is read (gone), c moved to the top with a new count, d is new.
  h.set([row("d"), row("c", 4), row("a", 1)]);
  expect(ids(h.result.current.rows)).toEqual(["a", "b", "c"]);
  expect(h.result.current.rows[1]).toMatchObject({ id: "b", n: 0, read: true });
  expect(h.result.current.rows[2]).toMatchObject({ id: "c", n: 4 });
  act(() => h.result.current.handlers.onPointerLeave());
  expect(ids(h.result.current.rows)).toEqual(["d", "c", "a"]);
});

test("it is released only when the pointer and the focus are both out", () => {
  const h = setup([row("a"), row("b")]);
  act(() => h.result.current.handlers.onPointerEnter());
  act(() => h.result.current.handlers.onFocus());
  act(() => h.result.current.handlers.onPointerLeave());
  expect(h.result.current.held).toBe(true);
  act(() => h.result.current.handlers.onBlur(leaving(null)));
  expect(h.result.current.held).toBe(false);
});

test("focus moving between the list's own rows does not release it", () => {
  const h = setup([row("a")]);
  act(() => h.result.current.handlers.onFocus());
  act(() => h.result.current.handlers.onBlur(leaving(document.body)));
  expect(h.result.current.held).toBe(true);
});

test("a new hold takes the order as it is then, not the earlier one", () => {
  const h = setup([row("a"), row("b")]);
  act(() => h.result.current.handlers.onPointerEnter());
  act(() => h.result.current.handlers.onPointerLeave());
  h.set([row("b"), row("a")]);
  act(() => h.result.current.handlers.onPointerEnter());
  h.set([row("a"), row("b")]);
  expect(ids(h.result.current.rows)).toEqual(["b", "a"]);
});
