import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAgentDetailsPanel } from "@/features/session/agent-details";
import type { Row } from "@/features/session/rows";
import { Timeline, type TimelineHandle } from "@/features/session/timeline";
import { installShortcuts } from "@/lib/shortcuts";
import { fakeMatchMedia } from "@/test/fake-match-media";

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
  document.elementFromPoint = () => null;
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

function setup(more?: { onLoadEarlier(): Promise<boolean> }) {
  const view = render(
    <Timeline
      slug="dev"
      rows={rows}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={more !== undefined}
      onLoadEarlier={more?.onLoadEarlier ?? (async () => false)}
      earlierError={false}
      footer={null}
    />,
  );
  const scroller = view.container.querySelector<HTMLElement>(".overflow-y-auto") as HTMLElement;
  const row = view.container.querySelector<HTMLElement>('[data-row="b"]') as HTMLElement;
  const rowA = view.container.querySelector<HTMLElement>('[data-row="a"]') as HTMLElement;
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
    row,
    rowA,
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

test("scrolled up, a height-only change keeps the top row in place too (U3 §8.1)", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller);
  t.setRowTop(160);
  t.resize(600); // same width
  expect(t.scroller.scrollTop).toBe(260);
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
  scroller.scrollTop = 4600; // at the bottom
  scrolled(scroller);
  scroller.scrollTop = 100; // the reader scrolls up
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

test("a probe that lands in the gap between rows falls back to the first row in view", () => {
  const t = setup();
  t.resize(600);
  document.elementFromPoint = () => null; // the point sits in the space between two rows
  t.rowA.getBoundingClientRect = () => ({ top: -60, bottom: 40 }) as DOMRect; // above the viewport top (50)
  let top = 100;
  t.row.getBoundingClientRect = () => ({ top, bottom: top + 60 }) as DOMRect;
  t.scroller.scrollTop = 200;
  scrolled(t.scroller);
  top = 160;
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(260);
});

test("a missed probe does not wipe a valid anchor", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller); // anchors the row at 100
  document.elementFromPoint = () => null;
  t.rowA.getBoundingClientRect = () => ({ top: -90, bottom: 10 }) as DOMRect;
  t.row.getBoundingClientRect = () => ({ top: -20, bottom: 30 }) as DOMRect; // nothing intersects the top
  scrolled(t.scroller); // the probe finds no row at all
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(80); // 200 + (-20 - 100): still corrected against the kept anchor
});

test("a disconnected anchor is skipped without throwing", () => {
  const t = setup();
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller);
  t.row.remove(); // its row was replaced
  expect(() => t.resize(480)).not.toThrow();
  expect(t.scroller.scrollTop).toBe(200);
});

test("while Load earlier is pending, a width change keeps the top row in place", () => {
  const t = setup({ onLoadEarlier: () => new Promise<boolean>(() => {}) });
  t.resize(600);
  t.scroller.scrollTop = 200;
  scrolled(t.scroller);
  fireEvent.click(t.view.getByRole("button", { name: "Load earlier" }));
  t.setRowTop(160);
  t.resize(480);
  expect(t.scroller.scrollTop).toBe(260);
});

/** The session page's wiring: the panel hook owns the timeline's handle, so `]` can anchor first. */
function PanelTimeline() {
  const panel = useAgentDetailsPanel("dev");
  return (
    <>
      <p>{panel.open ? "details open" : "details closed"}</p>
      <Timeline
        ref={panel.timeline}
        slug="dev"
        rows={rows}
        failedIds={new Set()}
        interruptedEnds={new Set()}
        hasMoreBefore={false}
        onLoadEarlier={async () => false}
        earlierError={false}
        footer={null}
      />
    </>
  );
}

test("] takes a fresh anchor before it toggles the in-flow panel, so the top row keeps its place", () => {
  const original = window.matchMedia;
  fakeMatchMedia.installWidth(1440);
  const off = installShortcuts();
  try {
    const view = render(<PanelTimeline />);
    expect(view.getByText("details open")).toBeInTheDocument();
    const scroller = view.container.querySelector<HTMLElement>(".overflow-y-auto") as HTMLElement;
    const row = view.container.querySelector<HTMLElement>('[data-row="c"]') as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.getBoundingClientRect = () => ({ top: 0, left: 0, width: 600 }) as DOMRect;
    let top = 30;
    row.getBoundingClientRect = () => ({ top }) as DOMRect;
    document.elementFromPoint = () => row;
    scroller.scrollTop = 4600; // at the bottom
    scrolled(scroller);
    scroller.scrollTop = 100; // the reader scrolls up
    scrolled(scroller);
    top = 40; // the row moved with no scroll event, so the passive anchor is stale
    fireEvent.keyDown(document.body, { key: "]" });
    expect(view.getByText("details closed")).toBeInTheDocument();
    top = 90; // the panel closed: the timeline widened and the row moved
    const rec = observers.find((o) => o.targets.includes(scroller));
    act(() => {
      rec?.cb([{ target: scroller, contentRect: { width: 600 } } as never], {} as ResizeObserver);
      rec?.cb([{ target: scroller, contentRect: { width: 900 } } as never], {} as ResizeObserver);
    });
    expect(scroller.scrollTop).toBe(150); // 100 + (90 - 40), not the stale 100 + (90 - 30)
  } finally {
    off();
    window.matchMedia = original;
  }
});
