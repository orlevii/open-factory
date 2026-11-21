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
    [
      "<div role='grid'><div role='row'><div role='gridcell'>c</div></div></div>",
      "[role=gridcell]",
      true,
    ],
    ["<div role='radiogroup'><div role='radio'>r</div></div>", "[role=radio]", true],
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

describe("open dialogs", () => {
  const fire = () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useShortcut("c", handler));
    press(document.body.querySelector("button") ?? document.body, "c");
    unmount();
    return handler.mock.calls.length;
  };

  test("a modal Radix dialog (role=dialog, no aria-modal) blocks shortcuts", () => {
    mount("<div role='dialog' data-state='open'><button>b</button></div>");
    expect(fire()).toBe(0);
  });
  test("a closed dialog does not", () => {
    mount("<div role='dialog' data-state='closed'><button>b</button></div>");
    expect(fire()).toBe(1);
  });
  test("a non-modal peek (data-modal=false) does not", () => {
    mount("<div role='dialog' data-state='open' data-modal='false'><button>b</button></div>");
    expect(fire()).toBe(1);
  });
  test("a popover (role=dialog) does not", () => {
    mount(
      "<div role='dialog' data-state='open' data-slot='popover-content'><button>b</button></div>",
    );
    expect(fire()).toBe(1);
  });
});

describe("key edge cases", () => {
  test("a held key fires once", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("c", handler));
    press(document.body, "c");
    press(document.body, "c", { repeat: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  test("keyCode 229 (IME) is ignored", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("c", handler));
    press(document.body, "c", { keyCode: 229 });
    expect(handler).not.toHaveBeenCalled();
  });
  test("a bare modifier between g and i keeps the sequence", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("g i", handler));
    press(document.body, "g");
    press(document.body, "Shift");
    press(document.body, "i");
    expect(handler).toHaveBeenCalledTimes(1);
  });
  test("an ignored key clears a pending sequence", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("g i", handler));
    press(document.body, "g");
    mount("<input />");
    press(document.body.firstElementChild as Element, "x");
    document.body.innerHTML = "";
    press(document.body, "i");
    expect(handler).not.toHaveBeenCalled();
  });
  test("Option+] on a US Mac (key '‘', code BracketRight) fires ']'", () => {
    const handler = vi.fn();
    renderHook(() => useShortcut("]", handler));
    press(document.body, "‘", { altKey: true, code: "BracketRight" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
