import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { consumeLongPressRelease, useLongPress } from "./use-long-press";

function Row({
  onLongPress,
  onClick,
}: {
  onLongPress: (at: { x: number; y: number }) => void;
  onClick?: () => void;
}) {
  const handlers = useLongPress(onLongPress);
  return (
    <button type="button" data-testid="row" {...handlers} onClick={onClick}>
      row
    </button>
  );
}

const touch = (x = 10, y = 20, pointerId = 1) => ({
  pointerType: "touch",
  clientX: x,
  clientY: y,
  pointerId,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  consumeLongPressRelease();
});

function setup(onClick?: () => void) {
  const onLongPress = vi.fn();
  const view = render(<Row onLongPress={onLongPress} onClick={onClick} />);
  return { onLongPress, el: view.getByTestId("row"), ...view };
}

test("fires at 500ms with the press point, not at 499", () => {
  const { onLongPress, el } = setup();
  fireEvent.pointerDown(el, touch(10, 20));
  act(() => void vi.advanceTimersByTime(499));
  expect(onLongPress).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(1));
  expect(onLongPress).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20 });
});

test("vibrates on fire when available", () => {
  const vibrate = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  const { el } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  expect(vibrate).toHaveBeenCalledWith(10);
  Reflect.deleteProperty(navigator, "vibrate");
});

test("more than 8px of movement cancels, 8px does not", () => {
  const { onLongPress, el } = setup();
  fireEvent.pointerDown(el, touch(10, 20));
  fireEvent.pointerMove(el, touch(18, 20));
  act(() => void vi.advanceTimersByTime(500));
  expect(onLongPress).toHaveBeenCalledTimes(1);

  onLongPress.mockClear();
  fireEvent.pointerUp(el, touch());
  fireEvent.pointerDown(el, touch(10, 20));
  fireEvent.pointerMove(el, touch(19, 20));
  act(() => void vi.advanceTimersByTime(600));
  expect(onLongPress).not.toHaveBeenCalled();
});

test("pointercancel and an early pointerup cancel", () => {
  const { onLongPress, el } = setup();
  fireEvent.pointerDown(el, touch());
  fireEvent.pointerCancel(el, touch());
  act(() => void vi.advanceTimersByTime(600));
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(300));
  fireEvent.pointerUp(el, touch());
  act(() => void vi.advanceTimersByTime(600));
  expect(onLongPress).not.toHaveBeenCalled();
});

test("a second pointer cancels", () => {
  const { onLongPress, el } = setup();
  fireEvent.pointerDown(el, touch(10, 20, 1));
  fireEvent.pointerDown(el, touch(40, 20, 2));
  act(() => void vi.advanceTimersByTime(600));
  expect(onLongPress).not.toHaveBeenCalled();
});

test("mouse and pen never fire", () => {
  const { onLongPress, el } = setup();
  fireEvent.pointerDown(el, { ...touch(), pointerType: "mouse" });
  fireEvent.pointerDown(el, { ...touch(), pointerType: "pen", pointerId: 3 });
  act(() => void vi.advanceTimersByTime(600));
  expect(onLongPress).not.toHaveBeenCalled();
});

test("data-pressed appears after 80ms and is removed on up", () => {
  const { el } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(79));
  expect(el).not.toHaveAttribute("data-pressed");
  act(() => void vi.advanceTimersByTime(1));
  expect(el).toHaveAttribute("data-pressed");
  fireEvent.pointerUp(el, touch());
  expect(el).not.toHaveAttribute("data-pressed");
});

test("data-pressed is removed on cancel and on movement cancel", () => {
  const { el } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(100));
  fireEvent.pointerCancel(el, touch());
  expect(el).not.toHaveAttribute("data-pressed");
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(100));
  fireEvent.pointerMove(el, touch(50, 50));
  expect(el).not.toHaveAttribute("data-pressed");
});

test("the click after a fire is swallowed, the next one is not", () => {
  const onClick = vi.fn();
  const { el } = setup(onClick);
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  fireEvent.pointerUp(el, touch());
  fireEvent.click(el);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(el);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("a click with no preceding fire is untouched", () => {
  const onClick = vi.fn();
  const { el } = setup(onClick);
  fireEvent.pointerDown(el, touch());
  fireEvent.pointerUp(el, touch());
  fireEvent.click(el);
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("one release is marked after a fire and consumed once", () => {
  const { el } = setup();
  expect(consumeLongPressRelease()).toBe(false);
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  expect(consumeLongPressRelease()).toBe(true);
  expect(consumeLongPressRelease()).toBe(false);
});

test("contextmenu during a touch press is prevented, a mouse right-click is not", () => {
  const { el } = setup();
  expect(fireEvent.contextMenu(el)).toBe(true);
  fireEvent.pointerDown(el, touch());
  expect(fireEvent.contextMenu(el)).toBe(false);
  act(() => void vi.advanceTimersByTime(500));
  fireEvent.pointerUp(el, touch());
  expect(fireEvent.contextMenu(el)).toBe(false);
  fireEvent.click(el);
  fireEvent.pointerDown(el, { ...touch(), pointerType: "mouse", pointerId: 9 });
  expect(fireEvent.contextMenu(el)).toBe(true);
});

test("unmounting mid-press never fires and clears data-pressed", () => {
  const { onLongPress, el, unmount } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(100));
  expect(el).toHaveAttribute("data-pressed");
  unmount();
  expect(el).not.toHaveAttribute("data-pressed");
  act(() => void vi.advanceTimersByTime(600));
  expect(onLongPress).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

const seen: object[] = [];
function Probe({ cb }: { cb: () => void }) {
  const h = useLongPress(cb);
  seen.push(h);
  return <div data-testid="p" {...h} />;
}

test("handlers are identity-stable and call the latest callback", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender, getByTestId } = render(<Probe cb={first} />);
  rerender(<Probe cb={second} />);
  expect(seen[0]).toBe(seen[seen.length - 1]);
  fireEvent.pointerDown(getByTestId("p"), touch());
  act(() => void vi.advanceTimersByTime(500));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test("a stale release mark does not survive the next press or a delay", () => {
  const { el } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  fireEvent.pointerUp(el, touch());
  fireEvent.pointerDown(el, touch());
  expect(consumeLongPressRelease()).toBe(false);
  fireEvent.pointerUp(el, touch());

  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  fireEvent.pointerUp(el, touch());
  act(() => void vi.advanceTimersByTime(1001));
  expect(consumeLongPressRelease()).toBe(false);
});

test("a long hold after the fire keeps the mark until the finger lifts", () => {
  const { el } = setup();
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(3000));
  expect(consumeLongPressRelease()).toBe(true);
});

test("contextmenu and click are no longer suppressed once the release grace passes", () => {
  const onClick = vi.fn();
  const { el } = setup(onClick);
  fireEvent.pointerDown(el, touch());
  act(() => void vi.advanceTimersByTime(500));
  fireEvent.pointerUp(el, touch());
  act(() => void vi.advanceTimersByTime(1001));
  expect(fireEvent.contextMenu(el)).toBe(true);
  fireEvent.click(el);
  expect(onClick).toHaveBeenCalledTimes(1);
});
