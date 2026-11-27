import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { refFor } from "@/test/refs";
import { arrivedSince, JumpPill } from "./jump-pill";
import { isSpeechRow, type Row } from "./rows";
import { Timeline } from "./timeline";

const NOOP = () => {};
const pill = () => document.querySelector<HTMLButtonElement>(".jump-pill") as HTMLButtonElement;

test.each([
  [{ speech: 1, other: false, windowed: false }, "1 new message"],
  [{ speech: 3, other: true, windowed: false }, "3 new messages"],
  [{ speech: 140, other: false, windowed: false }, "99+ new messages"],
  [{ speech: 0, other: true, windowed: false }, "New output"],
  [{ speech: 0, other: false, windowed: true }, "Jump to latest"],
  [{ speech: 2, other: false, windowed: true }, "2 new messages"],
])("label %o → %s", (p, label) => {
  render(<JumpPill shown {...p} onJump={NOOP} />);
  expect(pill()).toHaveAccessibleName(label);
  expect(pill().textContent).not.toMatch(/·|\b0\b/);
});

test("always mounted: inert and without data-shown while hidden", () => {
  const view = render(
    <JumpPill shown={false} speech={0} other={false} windowed={false} onJump={NOOP} />,
  );
  expect(pill()).toHaveAttribute("inert");
  expect(pill()).not.toHaveAttribute("data-shown");
  view.rerender(<JumpPill shown speech={0} other windowed={false} onJump={NOOP} />);
  expect(pill()).not.toHaveAttribute("inert");
  expect(pill()).toHaveAttribute("data-shown");
});

test("while it hides it keeps the last label shown (no flash to Jump to latest during the exit)", () => {
  const view = render(<JumpPill shown speech={3} other={false} windowed={false} onJump={NOOP} />);
  expect(pill()).toHaveAccessibleName("3 new messages");
  // The jump clears the counts in the same commit that hides it.
  view.rerender(<JumpPill shown={false} speech={0} other={false} windowed={false} onJump={NOOP} />);
  expect(pill()).toHaveAccessibleName("3 new messages");
  // Shown again, it says what is new now.
  view.rerender(<JumpPill shown speech={0} other windowed={false} onJump={NOOP} />);
  expect(pill()).toHaveAccessibleName("New output");
});

const msg = (seq: number, i = 0): Row =>
  ({
    key: `${seq}:${i}`,
    seq,
    kind: "message",
    at: "2026-11-21T00:00:00.000Z",
    message: { id: `m${seq}`, from: "@or", kind: "message", urgent: false, body: `m${seq}` },
  }) as unknown as Row;
const text = (seq: number): Row => ({
  kind: "text",
  seq,
  at: "2026-11-21T00:00:00.000Z",
  text: `t${seq}`,
  key: `${seq}`,
  head: false,
});
const quiet = (seq: number): Row =>
  ({
    kind: "error",
    seq,
    key: `${seq}`,
    event: { type: "error", message: "boom" },
  }) as unknown as Row;

test("isSpeechRow: messages, outgoing and text", () => {
  expect(isSpeechRow(msg(1))).toBe(true);
  expect(isSpeechRow(text(2))).toBe(true);
  expect(isSpeechRow({ kind: "outgoing" } as Row)).toBe(true);
  expect(isSpeechRow(quiet(3))).toBe(false);
});

function setup(extra: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const base = [msg(1), text(2)];
  const props = {
    agentRef: refFor("dev"),
    rows: base,
    failedIds: new Set<string>(),
    interruptedEnds: new Set<number>(),
    hasMoreBefore: false,
    onLoadEarlier: async () => false,
    earlierError: false,
    footer: null,
    ...extra,
  };
  const view = render(<Timeline {...props} />);
  const scroller = screen.getByRole("log").parentElement as HTMLElement;
  Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
  const scrollUp = () => {
    scroller.scrollTop = 1600;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
  };
  const rerender = (rows: Row[], more: Partial<Parameters<typeof Timeline>[0]> = {}) =>
    view.rerender(<Timeline {...props} {...more} rows={rows} />);
  return { view, scroller, scrollUp, rerender, base };
}

test("scrolled up, speech rows count as messages; other rows alone say New output", () => {
  const t = setup();
  expect(pill()).not.toHaveAttribute("data-shown");
  t.scrollUp();
  expect(pill()).not.toHaveAttribute("data-shown"); // nothing arrived yet
  t.rerender([...t.base, quiet(3)]);
  expect(pill()).toHaveAttribute("data-shown");
  expect(pill()).toHaveAccessibleName("New output");
  t.rerender([...t.base, quiet(3), text(4)]);
  expect(pill()).toHaveAccessibleName("1 new message");
  t.rerender([...t.base, quiet(3), text(4), msg(5), msg(5, 1)]);
  expect(pill()).toHaveAccessibleName("3 new messages");
});

test("a merged failure as the last row: scrolling up shows no false New output", () => {
  const merged = { ...quiet(3), count: 3, seqs: [3, 4, 5] } as Row;
  const t = setup({ rows: [msg(1), text(2), merged] });
  t.scrollUp();
  expect(pill()).not.toHaveAttribute("data-shown");
  // A real repeat folded into it is still new.
  t.rerender([msg(1), text(2), { ...merged, count: 4, seqs: [3, 4, 5, 6] } as Row]);
  expect(pill()).toHaveAccessibleName("New output");
});

test("a handed-off row doesn't count again", () => {
  const t = setup();
  t.scrollUp();
  t.rerender([...t.base, msg(3)], { handedOff: new Set(["3:0"]) });
  expect(pill()).not.toHaveAttribute("data-shown"); // it replaced a queued block: nothing new
  t.rerender([...t.base, msg(3), text(4)], { handedOff: new Set(["3:0"]) });
  expect(pill()).toHaveAccessibleName("1 new message");
});

test("the pill scrolls to the bottom and re-pins; it hides", () => {
  const t = setup();
  t.scrollUp();
  t.rerender([...t.base, text(3)]);
  fireEvent.click(pill());
  expect(t.scroller.scrollTop).toBe(2000);
  expect(pill()).not.toHaveAttribute("data-shown");
  t.rerender([...t.base, text(3), text(4)]); // pinned again: follows, counts nothing
  expect(pill()).not.toHaveAttribute("data-shown");
  expect(t.scroller.scrollTop).toBe(2000);
});

test("after the pill re-pins, focus is on the last row, not dropped to body", () => {
  const t = setup();
  t.scrollUp();
  t.rerender([...t.base, text(3)]);
  act(() => pill().focus());
  fireEvent.click(pill());
  expect(document.activeElement).toBe(document.querySelector('[data-row="3"]'));
});

test("windowed: always shown, counts the reducer's speech, and the click leaves the window", () => {
  const onLeaveWindow = vi.fn();
  const t = setup({ windowed: true, newSpeech: 0, onLeaveWindow });
  expect(pill()).toHaveAttribute("data-shown");
  expect(pill()).toHaveAccessibleName("Jump to latest");
  t.rerender(t.base, { windowed: true, newSpeech: 2, onLeaveWindow });
  expect(pill()).toHaveAccessibleName("2 new messages");
  fireEvent.click(pill());
  expect(onLeaveWindow).toHaveBeenCalledTimes(1);
});

test("End in the log focuses the last loaded row and re-pins; it never leaves the window", () => {
  const onLeaveWindow = vi.fn();
  const t = setup({ windowed: true, newSpeech: 1, onLeaveWindow });
  t.scrollUp();
  const first = document.querySelector<HTMLElement>('[data-row="1:0"]') as HTMLElement;
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  expect(document.activeElement).toBe(document.querySelector('[data-row="2"]'));
  expect(t.scroller.scrollTop).toBe(2000);
  expect(onLeaveWindow).not.toHaveBeenCalled();
});

test("a repeat folded into a failure above what was seen still counts as new output", () => {
  const merged = { ...quiet(5), count: 2, seqs: [5, 9] } as unknown as Row;
  expect(arrivedSince([text(1), merged], 6, new Set())).toEqual({ speech: 0, other: true });
  expect(arrivedSince([text(1), merged], 9, new Set())).toEqual({ speech: 0, other: false });
});

test("a live text block counts once: the persisted block that retires it doesn't count again", () => {
  const block = (text: string) => [
    { messageId: "m9", index: 1, text, capped: false, fromReset: false },
  ];
  const t = setup({ liveTexts: block("Hel") });
  t.scrollUp();
  // On screen when the reader scrolled up: not new.
  t.rerender(t.base, { liveTexts: block("Hello") });
  expect(pill()).not.toHaveAttribute("data-shown");
  const later = (text: string) => [
    { messageId: "m9", index: 3, text, capped: false, fromReset: false },
  ];
  t.rerender(t.base, { liveTexts: later("New") });
  expect(pill()).toHaveAccessibleName("1 new message");
  const done: Row = { ...text(5), key: "t:m9:3" };
  t.rerender([...t.base, done], { liveTexts: [], handedOff: new Set(["t:m9:3"]) });
  expect(pill()).toHaveAccessibleName("1 new message");
});
