import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrive, useArrivalTint } from "./use-arrival";

let visible = true;
vi.mock("@/hooks/use-document-visible", () => ({ useDocumentVisible: () => visible }));

beforeEach(() => {
  visible = true;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("arrive", () => {
  it("focuses without scrolling and never scrolls itself", () => {
    const el = document.createElement("div");
    el.tabIndex = -1;
    document.body.append(el);
    const focus = vi.spyOn(el, "focus");
    el.scrollIntoView = vi.fn();
    arrive(el);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    el.remove();
  });
  it("adds data-focus-ring when :focus-visible doesn't match, removed on blur", () => {
    const el = document.createElement("div");
    el.tabIndex = -1;
    document.body.append(el);
    vi.spyOn(el, "matches").mockReturnValue(false);
    arrive(el);
    expect(el.hasAttribute("data-focus-ring")).toBe(true);
    el.dispatchEvent(new Event("blur"));
    expect(el.hasAttribute("data-focus-ring")).toBe(false);
    el.remove();
  });
});

describe("useArrivalTint", () => {
  it("is on after start, fading 2 s later, cleared by onArrivedEnd", () => {
    const { result } = renderHook(() => useArrivalTint());
    expect(result.current.arrival).toBeUndefined();
    act(() => result.current.start());
    expect(result.current.arrival).toBe("on");
    act(() => void vi.advanceTimersByTime(1999));
    expect(result.current.arrival).toBe("on");
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.arrival).toBe("fading");
    act(() => result.current.onArrivedEnd());
    expect(result.current.arrival).toBeUndefined();
  });
  it("counts visible time only", () => {
    const { result, rerender } = renderHook(() => useArrivalTint());
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(1500));
    visible = false;
    rerender();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.arrival).toBe("on");
    visible = true;
    rerender();
    act(() => void vi.advanceTimersByTime(499));
    expect(result.current.arrival).toBe("on");
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.arrival).toBe("fading");
  });
  it("a second start gets the full time again", () => {
    const { result } = renderHook(() => useArrivalTint());
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(2000));
    act(() => result.current.onArrivedEnd());
    act(() => result.current.start());
    act(() => void vi.advanceTimersByTime(1999));
    expect(result.current.arrival).toBe("on");
  });
  it("start and onArrivedEnd keep their identity", () => {
    const { result, rerender } = renderHook(() => useArrivalTint());
    const { start, onArrivedEnd } = result.current;
    act(() => result.current.start());
    rerender();
    expect(result.current.start).toBe(start);
    expect(result.current.onArrivedEnd).toBe(onArrivedEnd);
  });
});
