import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Row } from "@/features/session/rows";
import { Timeline, type TimelineHandle } from "@/features/session/timeline";

type RO = { cb: ResizeObserverCallback; targets: Element[] };
const observers: RO[] = [];
const frames: FrameRequestCallback[] = [];
/** The scroll listener is rAF-throttled: run the frame it asked for. */
const scrolled = (el: Element) => {
  fireEvent.scroll(el);
  act(() => {
    for (const f of frames.splice(0)) f(0);
  });
};

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      rec: RO;
      constructor(cb: ResizeObserverCallback) {
        this.rec = { cb, targets: [] };
        observers.push(this.rec);
      }
      observe(t: Element) {
        this.rec.targets.push(t);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  // biome-ignore lint/suspicious/noExplicitAny: jsdom lacks elementFromPoint
  delete (document as any).elementFromPoint;
});

const rows: Row[] = ["a", "b", "c"].map(
  (k, i) =>
    ({
      key: k,
      seq: i + 1,
      kind: "message",
      message: { id: k, from: "@or", kind: "message", urgent: false, body: k },
    }) as unknown as Row,
);

function setup() {
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
  const scroller = view.container.querySelector<HTMLElement>(".overflow-y-auto") as HTMLElement;
  const row = view.container.querySelector<HTMLElement>('[data-row="b"]') as HTMLElement;
  let scrollHeight = 1000;
  Object.defineProperty(scroller, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  scroller.getBoundingClientRect = () => ({ top: 50, left: 0, width: 600 }) as DOMRect;
  let rowTop = 100;
  row.getBoundingClientRect = () => ({ top: rowTop }) as DOMRect;
  document.elementFromPoint = () => row;
  const resize = (width: number) => {
    const rec = observers.find((o) => o.targets.includes(scroller));
    if (!rec) throw new Error("scroller is not observed");
    act(() => {
      rec.cb(
        [{ target: scroller, contentRect: { width } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
  };
  return {
    scroller,
    resize,
    setRowTop: (n: number) => {
      rowTop = n;
    },
    setScrollHeight: (n: number) => {
      scrollHeight = n;
    },
    view,
  };
}

test("at the bottom, a width change keeps it pinned", () => {
  const t = setup();
  t.resize(600); // first measurement
  t.scroller.scrollTop = 600;
  scrolled(t.scroller); // 1000-600-400 = 0: at the bottom
  t.setScrollHeight(1300);
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(1300);
});

test("scrolled up, a width change restores the top row's offset by delta, synchronously in the RO callback", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller); // far from the bottom; the row at the top sits at 100
  t.setRowTop(160); // the columns narrowed and the row moved down by 60
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(260);
});

test("a height-only change does not move a scrolled-up reader", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller);
  t.setRowTop(160);
  t.resize(600); // same width
  expect(t.scroller.scrollTop).toBe(200);
});

test("atBottom is not recomputed in the RO callback", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 600;
  scrolled(t.scroller); // at the bottom
  // A reflow makes the scroller look far from the bottom, with no scroll event.
  t.setScrollHeight(2000);
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(2000); // still treated as pinned
});

test("captureAnchor takes a fresh anchor for a toggle that follows no scroll", () => {
  const ref = createRef<TimelineHandle>();
  const view = render(
    <Timeline
      ref={ref}
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
  const scroller = view.container.querySelector<HTMLElement>(".overflow-y-auto") as HTMLElement;
  const row = view.container.querySelector<HTMLElement>('[data-row="c"]') as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  scroller.getBoundingClientRect = () => ({ top: 0, left: 0, width: 600 }) as DOMRect;
  let top = 30;
  row.getBoundingClientRect = () => ({ top }) as DOMRect;
  document.elementFromPoint = () => row;
  scroller.scrollTop = 100;
  scrolled(scroller);
  top = 40; // the row moved with no scroll event, so the passive anchor is stale
  act(() => ref.current?.captureAnchor());
  top = 90;
  const rec = observers.find((o) => o.targets.includes(scroller));
  act(() => {
    rec?.cb([{ target: scroller, contentRect: { width: 600 } } as never], {} as ResizeObserver);
    rec?.cb([{ target: scroller, contentRect: { width: 500 } } as never], {} as ResizeObserver);
  });
  expect(scroller.scrollTop).toBe(150);
});
