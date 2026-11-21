import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installShortcuts, SINGLE_KEYS_PREF, shouldIgnore, useShortcut } from "./shortcuts";

let uninstall: () => void;

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  uninstall = installShortcuts();
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

describe("shouldIgnore", () => {
  test.each([
    ["<input />", "input", true],
    ["<textarea></textarea>", "textarea", true],
    ["<div contenteditable='true'>x</div>", "div", true],
    ["<div role='menu'><button>b</button></div>", "button", true],
    ["<div role='listbox'><div>o</div></div>", "div", true],
    ["<div role='tree'><a href='#'>a</a></div>", "a", true],
    ["<div>plain</div>", "div", false],
  ])("inside %s → ignored %s", (html, sel, ignored) => {
    const root = mount(html);
    const el = root.matches(sel) ? root : (root.querySelector(sel) as Element);
    const handler = vi.fn();
    const { unmount } = renderHook(() => useShortcut("c", handler));
    press(el, "c");
    expect(handler.mock.calls.length > 0).toBe(!ignored);
    unmount();
  });

  test("ignored with Ctrl/Meta, during IME, when defaultPrevented, or with a modal open", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("c", handler));
    press(document.body, "c", { ctrlKey: true });
    press(document.body, "c", { metaKey: true });
    press(document.body, "c", { isComposing: true });
    const prevented = new KeyboardEvent("keydown", { key: "c", cancelable: true });
    prevented.preventDefault();
    expect(shouldIgnore(prevented)).toBe(true);
    mount("<div aria-modal='true'></div>");
    press(document.body, "c");
    mount("<div role='alertdialog'></div>");
    press(document.body, "c");
    expect(handler).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    press(document.body, "c");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

test("Alt is allowed when it produced the bound key (']' via Option)", () => {
  const handler = vi.fn();
  renderHook(() => useShortcut("]", handler));
  press(document.body, "]", { altKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

test("a handled key has its default prevented", () => {
  renderHook(() => useShortcut("c", vi.fn()));
  expect(press(document.body, "c").defaultPrevented).toBe(true);
});

test("'g i' within 1s fires; after 1s doesn't", () => {
  vi.useFakeTimers();
  const handler = vi.fn();
  renderHook(() => useShortcut("g i", handler));
  press(document.body, "g");
  vi.advanceTimersByTime(900);
  press(document.body, "i");
  expect(handler).toHaveBeenCalledTimes(1);
  press(document.body, "g");
  vi.advanceTimersByTime(1100);
  press(document.body, "i");
  expect(handler).toHaveBeenCalledTimes(1);
});

test("the off switch disables single keys", () => {
  uninstall();
  localStorage.setItem(SINGLE_KEYS_PREF, "off");
  uninstall = installShortcuts();
  const handler = vi.fn();
  renderHook(() => useShortcut("c", handler));
  press(document.body, "c");
  expect(handler).not.toHaveBeenCalled();
});

describe("registration", () => {
  test("latest registration wins and unregisters on unmount", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useShortcut("c", a));
    const second = renderHook(() => useShortcut("c", b));
    press(document.body, "c");
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    second.unmount();
    press(document.body, "c");
    expect(a).toHaveBeenCalledTimes(1);
  });

  test("re-rendering an earlier registrant doesn't steal the key from a later one", () => {
    const a = vi.fn();
    const b = vi.fn();
    const first = renderHook(({ fn }) => useShortcut("c", fn), { initialProps: { fn: a } });
    renderHook(() => useShortcut("c", b));
    first.rerender({ fn: vi.fn() });
    press(document.body, "c");
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("a re-render uses the latest handler", () => {
    const a = vi.fn();
    const a2 = vi.fn();
    const first = renderHook(({ fn }) => useShortcut("c", fn), { initialProps: { fn: a } });
    first.rerender({ fn: a2 });
    press(document.body, "c");
    expect(a).not.toHaveBeenCalled();
    expect(a2).toHaveBeenCalledTimes(1);
  });

  test("enabled: false registers nothing", () => {
    const a = vi.fn();
    const r = renderHook(({ on }) => useShortcut("c", a, { enabled: on }), {
      initialProps: { on: false },
    });
    press(document.body, "c");
    expect(a).not.toHaveBeenCalled();
    act(() => r.rerender({ on: true }));
    press(document.body, "c");
    expect(a).toHaveBeenCalledTimes(1);
  });
});
