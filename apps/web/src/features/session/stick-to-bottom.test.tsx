import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Row } from "./rows";
import { repinTimeline } from "./session-commands";
import { type StickToBottom, useStickToBottom } from "./stick-to-bottom";
import { Timeline } from "./timeline";

// jsdom has no layout: the scroller's metrics are stubbed (scrollTop clamps like a browser), rows sit
// at a document position and report `pos - scrollTop` as their viewport top, and the
// ResizeObserver is a fake the test triggers.
const observers: ResizeObserverCallback[] = [];
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.getSelection()?.removeAllRanges();
  document.elementFromPoint = () => null;
});

const CLIENT = 400;

function Harness({ api }: { api: { current?: StickToBottom } }) {
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  api.current = useStickToBottom(scroller, log);
  return (
    <>
      <div data-testid="scroller" ref={scroller}>
        <div role="log" ref={log}>
          <div data-row="a" tabIndex={-1}>
            a
          </div>
          <div data-row="b" tabIndex={-1}>
            b
            <button type="button" aria-expanded="false">
              Toggle
            </button>
            <pre data-testid="nested" style={{ overflowY: "auto" }}>
              code
            </pre>
          </div>
        </div>
      </div>
      <textarea aria-label="Message" />
    </>
  );
}

function setup() {
  const api: { current?: StickToBottom } = {};
  const view = render(<Harness api={api} />);
  const scroller = view.getByTestId("scroller");
  let height = 1000;
  let top = 0;
  Object.defineProperty(scroller, "scrollHeight", { get: () => height, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => CLIENT, configurable: true });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - CLIENT));
    },
    configurable: true,
  });
  scroller.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 600, bottom: CLIENT }) as DOMRect;
  /** Places an element at a document position: its viewport top follows the scroll. */
  const place = (el: Element, pos: () => number) => {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ top: pos() - top, bottom: pos() - top + 50 }) as DOMRect;
  };
  const resize = (h: number) => {
    height = h;
    act(() => {
      for (const cb of observers) cb([], {} as ResizeObserver);
    });
  };
  /** A user scroll: the position changes, then the browser fires `scroll`. */
  const scrollTo = (v: number) => {
    scroller.scrollTop = v;
    fireEvent.scroll(scroller);
  };
  const pinned = () => api.current?.pinned.current;
  resize(1000); // the first layout: pinned, at the bottom
  fireEvent.scroll(scroller); // the browser reports our own write
  return { view, scroller, api, place, resize, scrollTo, pinned, top: () => top };
}

test("pinned, content growing 2,000px between scroll events stays pinned at the bottom", () => {
  const t = setup();
  expect(t.top()).toBe(600);
  t.resize(3000);
  expect(t.pinned()).toBe(true);
  expect(t.top()).toBe(3000 - CLIENT);
  fireEvent.scroll(t.scroller); // our write, reported late
  expect(t.pinned()).toBe(true);
});

test("a 40px wheel up during growth unpins, and growth never re-pins", () => {
  const t = setup();
  fireEvent.wheel(t.view.getByText("a"), { deltaY: -40 });
  expect(t.pinned()).toBe(false);
  t.resize(1500);
  fireEvent.scroll(t.scroller);
  t.resize(2000);
  fireEvent.scroll(t.scroller);
  expect(t.pinned()).toBe(false);
  expect(t.top()).toBe(600);
});

test("a scroll up we didn't write, ending far from the bottom, unpins", () => {
  const t = setup();
  t.scrollTo(500); // 100px from the bottom
  expect(t.pinned()).toBe(false);
});

test("a 200px shrink while pinned clamps the scroll but stays pinned", () => {
  const t = setup();
  t.resize(800); // the browser clamps scrollTop to 400 and fires scroll
  fireEvent.scroll(t.scroller);
  expect(t.pinned()).toBe(true);
});

test("re-pins only on a downward scroll ending within 8px of the previous scrollHeight's bottom", () => {
  const t = setup();
  t.scrollTo(200);
  expect(t.pinned()).toBe(false);
  t.resize(1500); // a streaming tail grows while unpinned
  t.scrollTo(300); // down, but far from the bottom
  expect(t.pinned()).toBe(false);
  t.scrollTo(250); // up
  expect(t.pinned()).toBe(false);
  // Previous scrollHeight is still 1500 here: 1500 - 1095 - 400 = 5.
  t.scrollTo(1095);
  expect(t.pinned()).toBe(true);
});

test("the re-pin target is the bottom at the previous scroll, not the grown one", () => {
  const t = setup();
  t.scrollTo(200); // scrollHeight 1000 at this scroll
  t.resize(1500);
  t.scrollTo(596); // 4px from the old bottom, 504px from the new one
  expect(t.pinned()).toBe(true);
});

test("PageUp inside the log unpins; typing in a textarea outside never does", () => {
  const t = setup();
  const box = t.view.getByRole("textbox", { name: "Message" });
  for (const key of ["PageUp", "Home", "ArrowUp"]) fireEvent.keyDown(box, { key });
  fireEvent.keyDown(box, { key: " ", shiftKey: true });
  expect(t.pinned()).toBe(true);
  fireEvent.keyDown(t.view.getByText("a"), { key: "PageUp" });
  expect(t.pinned()).toBe(false);
});

test("Shift+Space in the log unpins", () => {
  const t = setup();
  fireEvent.keyDown(t.view.getByText("a"), { key: " ", shiftKey: true });
  expect(t.pinned()).toBe(false);
});

test("a selection in the log unpins; collapsing it within 8px of the bottom re-pins", () => {
  const t = setup();
  const sel = document.getSelection() as Selection;
  const range = document.createRange();
  range.selectNodeContents(t.view.getByText("a"));
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(t.pinned()).toBe(false);
  t.scroller.scrollTop = 595; // no scroll event: only the collapse decides
  sel.collapseToEnd();
  fireEvent(document, new Event("selectionchange"));
  expect(t.pinned()).toBe(true);
});

test("a collapse far from the bottom doesn't re-pin", () => {
  const t = setup();
  const sel = document.getSelection() as Selection;
  const range = document.createRange();
  range.selectNodeContents(t.view.getByText("a"));
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  t.scroller.scrollTop = 100;
  sel.collapseToEnd();
  fireEvent(document, new Event("selectionchange"));
  expect(t.pinned()).toBe(false);
});

test("a toggle in the log anchors its own top and unpins; growth keeps it in place", () => {
  const t = setup();
  const toggle = t.view.getByRole("button", { name: "Toggle" });
  let pos = 900;
  t.place(toggle, () => pos);
  expect(toggle.getBoundingClientRect().top).toBe(300);
  fireEvent.click(toggle);
  expect(t.pinned()).toBe(false);
  pos = 1100; // something above it grew too
  t.resize(1400);
  expect(Math.abs(toggle.getBoundingClientRect().top - 300)).toBeLessThanOrEqual(1);
  expect(t.pinned()).toBe(false);
});

test("expandAnchor(el) then growth keeps el's top and unpins", () => {
  const t = setup();
  const row = t.view.getByText("a");
  let pos = 700;
  t.place(row, () => pos);
  act(() => t.api.current?.expandAnchor(row));
  expect(t.pinned()).toBe(false);
  pos = 950;
  t.resize(1250);
  expect(Math.abs(row.getBoundingClientRect().top - 100)).toBeLessThanOrEqual(1);
});

test("while unpinned, content growing above keeps the top visible row in place", () => {
  const t = setup();
  const row = t.view.getByText("a");
  let pos = 300;
  t.place(row, () => pos);
  document.elementFromPoint = () => row;
  t.scrollTo(200); // unpins; row a sits at the viewport's top (100)
  expect(t.pinned()).toBe(false);
  pos = 520; // a background task's line above it settled 220px taller
  t.resize(1220);
  expect(row.getBoundingClientRect().top).toBe(100);
  expect(t.top()).toBe(420);
  t.resize(1220); // a second observation with no change doesn't move it again
  expect(t.top()).toBe(420);
});

test("a mostly horizontal wheel, or one a nested scroller absorbs, doesn't unpin", () => {
  const t = setup();
  fireEvent.wheel(t.view.getByText("a"), { deltaX: -80, deltaY: -10 });
  expect(t.pinned()).toBe(true);
  const nested = t.view.getByTestId("nested");
  Object.defineProperty(nested, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
  nested.scrollTop = 50;
  fireEvent.wheel(nested, { deltaY: -40 });
  expect(t.pinned()).toBe(true);
  nested.scrollTop = 0; // at its own top: the wheel scrolls the timeline
  fireEvent.wheel(nested, { deltaY: -40 });
  expect(t.pinned()).toBe(false);
});

test("repin() scrolls to the bottom and pins", () => {
  const t = setup();
  t.scrollTo(100);
  expect(t.pinned()).toBe(false);
  act(() => t.api.current?.repin());
  expect(t.pinned()).toBe(true);
  expect(t.top()).toBe(600);
});

const rows: Row[] = ["a", "b"].map(
  (k, i) =>
    ({
      key: k,
      seq: i + 1,
      kind: "message",
      message: { id: k, from: "@or", kind: "message", urgent: false, body: k },
    }) as unknown as Row,
);

test("sending from the composer re-pins the agent's timeline", () => {
  const view = render(
    <Timeline
      slug="dev"
      rows={rows}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
  const scroller = view.getByRole("log").parentElement as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  scroller.scrollTop = 1600;
  fireEvent.scroll(scroller);
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  act(() => repinTimeline("other"));
  expect(scroller.scrollTop).toBe(100);
  act(() => repinTimeline("dev"));
  expect(scroller.scrollTop).toBe(2000);
});
