import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePref } from "./prefs";

const parseBool = (r: string) => (r === "1" ? true : r === "0" ? false : undefined);
const ser = (v: boolean) => (v ? "1" : "0");

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("usePref reads, writes and follows other tabs", () => {
  const { result } = renderHook(() => usePref("of-x", false, parseBool, ser));
  expect(result.current[0]).toBe(false);
  act(() => result.current[1](true));
  expect(localStorage.getItem("of-x")).toBe("1");
  expect(result.current[0]).toBe(true);
  act(() => {
    localStorage.setItem("of-x", "0");
    window.dispatchEvent(new StorageEvent("storage", { key: "of-x" }));
  });
  expect(result.current[0]).toBe(false);
});

test("usePref notifies other hooks on the same key in this tab", () => {
  const a = renderHook(() => usePref("of-y", false, parseBool, ser));
  const b = renderHook(() => usePref("of-y", false, parseBool, ser));
  act(() => a.result.current[1](true));
  expect(b.result.current[0]).toBe(true);
});

test("usePref survives a throwing localStorage", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result } = renderHook(() => usePref("of-z", "fb", (r) => r));
  expect(result.current[0]).toBe("fb");
  expect(() => act(() => result.current[1]("v"))).not.toThrow();
});

test("usePref falls back when the stored value does not parse or validate", () => {
  localStorage.setItem("of-j", "{not json");
  const parse = (r: string) => {
    const v = JSON.parse(r);
    return Array.isArray(v) ? (v as string[]) : undefined;
  };
  const { result } = renderHook(() => usePref<string[]>("of-j", [], parse, JSON.stringify));
  expect(result.current[0]).toEqual([]);
  act(() => {
    localStorage.setItem("of-j", '{"a":1}');
    window.dispatchEvent(new StorageEvent("storage", { key: "of-j" }));
  });
  expect(result.current[0]).toEqual([]);
});

test("usePref keeps a stable setter and a stable parsed value across rerenders", () => {
  localStorage.setItem("of-s", "[1]");
  const parse = (r: string) => JSON.parse(r) as number[];
  const { result, rerender } = renderHook(() => usePref<number[]>("of-s", [], parse));
  const [value, set] = result.current;
  rerender();
  expect(result.current[0]).toBe(value);
  expect(result.current[1]).toBe(set);
});
