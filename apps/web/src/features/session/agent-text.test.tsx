import { act, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { CAP_LINE } from "./agent-text";
import type { Row } from "./rows";
import type { LiveText } from "./session-state";
import { Timeline } from "./timeline";

const at = "2026-11-21T10:00:00.000Z";
const base: Row[] = [
  {
    kind: "message",
    seq: 1,
    at,
    message: { id: "e1", from: "@or", kind: "message", urgent: false, body: "Hi" },
    key: "1:0",
  },
];
const liveText = (messageId: string, index: number, text: string, over: Partial<LiveText> = {}) =>
  ({ messageId, index, text, capped: false, fromReset: false, ...over }) satisfies LiveText;
const persisted = (
  messageId: string,
  index: number,
  text: string,
  seq = 2,
): Extract<Row, { kind: "text" }> => ({
  kind: "text",
  seq,
  at,
  text,
  key: `t:${messageId}:${index}`,
  head: true,
});

type View = {
  rows: Row[];
  live: readonly LiveText[];
  handedOff?: ReadonlySet<string>;
  liveAfter?: number;
};
function renderTimeline(v: View) {
  const el = (x: View) => (
    <Timeline
      slug="dev"
      rows={x.rows}
      liveTexts={x.live}
      textHead
      liveAfter={x.liveAfter ?? 1}
      handedOff={x.handedOff}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />
  );
  const view = render(el(v));
  return { ...view, update: (x: View) => view.rerender(el(x)) };
}
const rowEl = (key: string) => document.querySelector<HTMLElement>(`[data-row="${key}"]`);
const selectIn = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
};

test("the persisted row keeps the live element (same DOM node) and the selection", () => {
  const view = renderTimeline({ rows: base, live: [liveText("m1", 1, "Hello wor")] });
  const node = rowEl("t:m1:1");
  expect(node).not.toBeNull();
  expect(node?.textContent).toContain("Hello wor");
  selectIn(node as HTMLElement);
  view.update({
    rows: [...base, persisted("m1", 1, "Hello world")],
    live: [],
    handedOff: new Set(["t:m1:1"]),
  });
  expect(rowEl("t:m1:1")).toBe(node);
  expect(node?.textContent).toContain("Hello world");
  expect(window.getSelection()?.isCollapsed).toBe(false);
  // The live row and the persisted one both open the turn's speaker line: nothing appears or goes.
  expect(node?.querySelectorAll("[data-speaker-line]")).toHaveLength(1);
});

test("a selection in the tail freezes it until the selection collapses", () => {
  const view = renderTimeline({ rows: base, live: [liveText("m1", 1, "Hello")] });
  const node = rowEl("t:m1:1") as HTMLElement;
  selectIn(node);
  view.update({ rows: base, live: [liveText("m1", 1, "Hello there")] });
  expect(node.textContent).toContain("Hello");
  expect(node.textContent).not.toContain("there");
  window.getSelection()?.removeAllRanges();
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(node.textContent).toContain("Hello there");
});

test("a selection elsewhere doesn't freeze the tail", () => {
  const view = renderTimeline({ rows: base, live: [liveText("m1", 1, "Hello")] });
  selectIn(rowEl("1:0") as HTMLElement);
  view.update({ rows: base, live: [liveText("m1", 1, "Hello there")] });
  expect(rowEl("t:m1:1")?.textContent).toContain("Hello there");
});

const wrapOf = (key: string) => rowEl(key)?.closest("[data-row-wrap]");

test("the live row fades only when its first text came from a non-reset frame", () => {
  const view = renderTimeline({ rows: base, live: [liveText("m1", 1, "Hi")] });
  const wrap = wrapOf("t:m1:1");
  expect(wrap).toHaveAttribute("data-live");
  // The handoff: the same wrap, never fading again.
  view.update({
    rows: [...base, persisted("m1", 1, "Hi there")],
    live: [],
    handedOff: new Set(["t:m1:1"]),
  });
  expect(wrapOf("t:m1:1")).toBe(wrap);
  expect(wrap).not.toHaveAttribute("data-live");
  view.update({
    rows: [...base, persisted("m1", 1, "Hi there")],
    live: [liveText("m2", 1, "Reloaded mid-answer", { fromReset: true })],
    handedOff: new Set(["t:m1:1"]),
  });
  expect(wrapOf("t:m2:1")).not.toHaveAttribute("data-live");
});

test("a capped block shows the cap line live and persisted", () => {
  const view = renderTimeline({
    rows: base,
    live: [liveText("m1", 1, "Long", { capped: true })],
  });
  const node = rowEl("t:m1:1") as HTMLElement;
  expect(node.textContent).toContain(CAP_LINE);
  expect(CAP_LINE).toBe("Cut at 64 KB; the full text stayed with the agent.");
  view.update({
    rows: [...base, { ...persisted("m1", 1, "Long"), capped: true }],
    live: [],
    handedOff: new Set(["t:m1:1"]),
  });
  expect(rowEl("t:m1:1")).toBe(node);
  expect(node.textContent).toContain(CAP_LINE);
  view.update({ rows: [...base, persisted("m1", 1, "Long")], live: [] });
  expect(node.textContent).not.toContain(CAP_LINE);
});

test("live rows sit after every persisted row, keep the gutter, and only the first opens a speaker line", () => {
  renderTimeline({
    rows: base,
    live: [liveText("m1", 1, "One"), liveText("m1", 3, "Two")],
  });
  const keys = [...document.querySelectorAll("[data-row]")].map((e) => e.getAttribute("data-row"));
  expect(keys).toEqual(["1:0", "t:m1:1", "t:m1:3"]);
  expect(rowEl("t:m1:1")?.querySelectorAll("[data-speaker-line]")).toHaveLength(1);
  expect(rowEl("t:m1:3")?.querySelectorAll("[data-speaker-line]")).toHaveLength(0);
  expect(wrapOf("t:m1:3")?.className).toContain("pr-8");
});

test("a windowed view renders no live rows", () => {
  render(
    <Timeline
      slug="dev"
      rows={base}
      liveTexts={[liveText("m1", 1, "Hello")]}
      windowed
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />,
  );
  expect(rowEl("t:m1:1")).toBeNull();
});
