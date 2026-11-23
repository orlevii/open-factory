import { readFileSync } from "node:fs";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useConfigDraft } from "./use-config-draft";

type V = Record<string, unknown>;
const v1 = { value: { template: { model: "opus" } } as V, version: "v1" };

function setup(initial = v1) {
  return renderHook(({ loaded }) => useConfigDraft<V>(loaded), {
    initialProps: { loaded: initial },
  });
}

test("clean: the draft is the loaded value, not dirty, no drift", () => {
  const { result } = setup();
  expect(result.current.draft).toBe(v1.value);
  expect(result.current.dirty).toBe(false);
  expect(result.current.drift).toBe(false);
  expect(result.current.conflicts).toEqual([]);
});

test("the first edit snapshots the base; a refetch then shows drift, and the draft is kept", () => {
  const { result, rerender } = setup();
  act(() => result.current.setDraft((d) => ({ ...d, settings: { theme: "dark" } })));
  expect(result.current.dirty).toBe(true);
  expect(result.current.draft).toEqual({
    template: { model: "opus" },
    settings: { theme: "dark" },
  });
  rerender({ loaded: { value: { template: { model: "sonnet" } }, version: "v2" } });
  expect(result.current.drift).toBe(true);
  expect(result.current.draft).toEqual({
    template: { model: "opus" },
    settings: { theme: "dark" },
  });
});

test("a refetch while clean follows the loaded value", () => {
  const { result, rerender } = setup();
  const v2 = { value: { template: { model: "sonnet" } }, version: "v2" };
  rerender({ loaded: v2 });
  expect(result.current.draft).toBe(v2.value);
  expect(result.current.drift).toBe(false);
});

test("rebase re-applies my edits over the loaded value, reports conflicts, and stays unsaved", () => {
  const { result, rerender } = setup();
  act(() => result.current.setDraft(() => ({ template: { model: "haiku" }, settings: { a: 1 } })));
  rerender({
    loaded: { value: { template: { model: "sonnet" }, mcp: { mcpServers: {} } }, version: "v2" },
  });
  act(() => result.current.rebase());
  expect(result.current.draft).toEqual({
    template: { model: "haiku" },
    mcp: { mcpServers: {} },
    settings: { a: 1 },
  });
  expect(result.current.conflicts).toEqual(["template.model"]);
  expect(result.current.drift).toBe(false);
  expect(result.current.dirty).toBe(true);
});

test("discard goes back to the loaded value; undo restores the edits until the next edit", () => {
  const { result } = setup();
  act(() => result.current.setDraft(() => ({ template: { model: "haiku" } })));
  act(() => result.current.discard());
  expect(result.current.dirty).toBe(false);
  expect(result.current.draft).toBe(v1.value);
  act(() => result.current.undoDiscard());
  expect(result.current.draft).toEqual({ template: { model: "haiku" } });
  act(() => result.current.discard());
  act(() => result.current.setDraft(() => ({ template: { model: "x" } })));
  act(() => result.current.undoDiscard());
  expect(result.current.draft).toEqual({ template: { model: "x" } });
});

test("a second discard while clean keeps Undo", () => {
  const { result } = setup();
  act(() => result.current.setDraft(() => ({ template: { model: "haiku" } })));
  act(() => result.current.discard());
  act(() => result.current.discard());
  act(() => result.current.undoDiscard());
  expect(result.current.draft).toEqual({ template: { model: "haiku" } });
});

test("reset (after a save) clears the edits without offering undo", () => {
  const { result } = setup();
  act(() => result.current.setDraft(() => ({})));
  act(() => result.current.reset());
  expect(result.current.dirty).toBe(false);
  act(() => result.current.undoDiscard());
  expect(result.current.dirty).toBe(false);
});

test("setDraft is stable while the loaded value is", () => {
  const { result, rerender } = setup();
  const first = result.current.setDraft;
  act(() => result.current.setDraft((d) => ({ ...d, x: 1 })));
  rerender({ loaded: v1 });
  expect(result.current.setDraft).toBe(first);
});

test("the hook holds no effect", () => {
  const src = readFileSync(path.join(import.meta.dirname, "use-config-draft.ts"), "utf8");
  expect(src).not.toMatch(/use(Layout)?Effect/);
});
