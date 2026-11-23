import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  chatDraftKey,
  readDraft,
  readRecipients,
  readUnconfirmed,
  sessionDraftKey,
  taskDraftKey,
  useDraft,
  writeDraft,
  writeRecipients,
  writeUnconfirmed,
} from "./drafts";

const KEY = sessionDraftKey("dev");
const stored = () => localStorage.getItem("of-draft:v1:session:dev");

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

/** A hook instance standing in for one tab's composer, with its focus handlers. */
function tab(key = KEY) {
  const r = renderHook(() => useDraft(key));
  return {
    ...r,
    text: () => r.result.current[0],
    type: (v: string) => act(() => r.result.current[1](v)),
    focus: () => act(() => r.result.current[2].bind.onFocus()),
    blur: () => act(() => r.result.current[2].bind.onBlur()),
  };
}

/** What another tab's write looks like to this one. */
function storageEvent(oldText: string | null, newText: string | null) {
  const enc = (t: string | null) =>
    t === null ? null : JSON.stringify({ text: t, at: Date.now() });
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "of-draft:v1:session:dev",
        oldValue: enc(oldText),
        newValue: enc(newText),
        storageArea: localStorage,
      }),
    );
  });
}

test("keys are versioned per agent and per task", () => {
  expect(sessionDraftKey("dev")).toBe("session:dev");
  expect(taskDraftKey("OF-12")).toBe("task:OF-12");
});

test("a draft survives a remount, stored as { text, at }", () => {
  const a = tab();
  a.focus();
  a.type("half a thought");
  a.unmount(); // a pending (throttled) write is flushed
  expect(JSON.parse(stored() ?? "{}")).toEqual({ text: "half a thought", at: expect.any(Number) });
  const b = tab();
  expect(b.text()).toBe("half a thought");
});

test("writes are throttled while typing and flushed on blur", () => {
  vi.useFakeTimers();
  const a = tab();
  a.focus();
  a.type("a");
  a.type("ab");
  expect(stored()).toBeNull();
  vi.advanceTimersByTime(150);
  expect(JSON.parse(stored() ?? "{}").text).toBe("ab");
  a.type("abc");
  a.blur();
  expect(JSON.parse(stored() ?? "{}").text).toBe("abc");
});

test("an unfocused instance never writes", () => {
  vi.useFakeTimers();
  const a = tab();
  a.type("programmatic");
  vi.advanceTimersByTime(1000);
  a.unmount();
  expect(stored()).toBeNull();
});

test("persist writes at once, focused or not (the app put text in the box)", () => {
  vi.useFakeTimers();
  const a = tab();
  a.type("put back");
  act(() => a.result.current[2].persist());
  expect(JSON.parse(stored() ?? "{}").text).toBe("put back");
});

test("an unconfirmed send is stored beside the draft and expires with it", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  writeUnconfirmed(KEY, { id: "c1", sent: "hello" });
  expect(readUnconfirmed(KEY)).toEqual({ id: "c1", sent: "hello" });
  vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
  expect(readUnconfirmed(KEY)).toBeUndefined();
  writeUnconfirmed(KEY, { id: "c2", sent: "x" });
  writeUnconfirmed(KEY, undefined);
  expect(readUnconfirmed(KEY)).toBeUndefined();
});

test("a draft expires after 7 days", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  const a = tab();
  a.focus();
  a.type("old");
  a.blur();
  a.unmount();
  vi.setSystemTime(new Date("2026-11-07T23:00:00Z"));
  expect(readDraft(KEY)).toBe("old");
  vi.setSystemTime(new Date("2026-11-08T00:00:01Z"));
  expect(readDraft(KEY)).toBe("");
  expect(tab().text()).toBe("");
  expect(stored()).toBeNull();
});

test("an unfocused tab adopts another tab's draft only when its own text is the value it replaces", () => {
  const b = tab();
  storageEvent(null, "from A");
  expect(b.text()).toBe("from A");
  storageEvent("from A", "from A, more");
  expect(b.text()).toBe("from A, more");
  // B's own text differs from what A replaced: B keeps it.
  b.type("mine");
  storageEvent("from A, more", "from A, again");
  expect(b.text()).toBe("mine");
});

test("two tabs never resurrect sent text", () => {
  const a = tab();
  const b = tab();
  a.focus();
  a.type("hello");
  a.blur();
  storageEvent(null, "hello"); // what B saw of A's write
  expect(b.text()).toBe("hello");
  // A sends it: the box empties, the stored draft keeps it until the server accepts it.
  a.focus();
  act(() => a.result.current[2].hold("hello"));
  act(() => a.result.current[1](""));
  expect(JSON.parse(stored() ?? "{}").text).toBe("hello");
  act(() => a.result.current[2].clearSent("hello"));
  expect(stored()).toBeNull();
  storageEvent("hello", null);
  expect(b.text()).toBe("");
  // B unmounting (or a pagehide) has nothing of its own to write back.
  b.unmount();
  window.dispatchEvent(new Event("pagehide"));
  expect(stored()).toBeNull();
  expect(tab().text()).toBe("");
});

test("clearSent removes only what was sent, keeping text typed since", () => {
  const a = tab();
  a.focus();
  a.type("first");
  act(() => a.result.current[2].hold("first"));
  a.type("second");
  a.blur();
  expect(JSON.parse(stored() ?? "{}").text).toBe("first\nsecond");
  act(() => a.result.current[2].clearSent("first"));
  expect(JSON.parse(stored() ?? "{}").text).toBe("second");
});

test("storage that throws (private mode) leaves the hook working", () => {
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  try {
    const a = tab();
    a.focus();
    a.type("x");
    a.blur();
    expect(a.text()).toBe("x");
  } finally {
    spy.mockRestore();
    set.mockRestore();
  }
});

test("the chat's draft holds text and recipients; each write keeps the other", () => {
  const key = chatDraftKey("dev");
  const raw = () => localStorage.getItem("of-draft:v1:chat:dev");
  writeRecipients(key, ["ops"]);
  expect(JSON.parse(raw() as string)).toMatchObject({ text: "", recipients: ["ops"] });
  writeDraft(key, "hi");
  expect(JSON.parse(raw() as string)).toMatchObject({ text: "hi", recipients: ["ops"] });
  expect(readRecipients(key)).toEqual(["ops"]);
  writeDraft(key, "");
  expect(readRecipients(key)).toEqual(["ops"]);
  writeRecipients(key, []);
  expect(raw()).toBeNull();
});

test("stored recipients are validated on read: a string[] of at most ten, else dropped", () => {
  const key = chatDraftKey("dev");
  const put = (recipients: unknown) =>
    localStorage.setItem(
      "of-draft:v1:chat:dev",
      JSON.stringify({ text: "hi", at: Date.now(), recipients }),
    );
  put(["a", 1]);
  expect(readRecipients(key)).toEqual([]);
  put(Array.from({ length: 11 }, (_, i) => `a${i}`));
  expect(readRecipients(key)).toEqual([]);
  put(Array.from({ length: 10 }, (_, i) => `a${i}`));
  expect(readRecipients(key)).toHaveLength(10);
  expect(readDraft(key)).toBe("hi");
});
