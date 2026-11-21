import { render } from "@testing-library/react";
import { createRef, type Ref, useEffect, useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { installInputModality, useStampedRef } from "./input-modality";

let off = () => {};
afterEach(() => off());

function Box({ r }: { r?: Ref<HTMLDivElement> }) {
  return <div ref={useStampedRef(r)} data-testid="n" />;
}
function Probe({ r, seen }: { r: Ref<HTMLDivElement>; seen: boolean[] }) {
  const stamped = useStampedRef(r);
  const first = useRef(stamped);
  useEffect(() => {
    seen.push(first.current === stamped);
  });
  return <div ref={stamped} />;
}

test("fills a ref object and stamps after keyboard input", () => {
  off = installInputModality();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const ref = createRef<HTMLDivElement>();
  const { getByTestId } = render(<Box r={ref} />);
  expect(ref.current).toBe(getByTestId("n"));
  expect(ref.current).toHaveAttribute("data-instant");
});

test("calls a function ref and does not stamp after pointer input", () => {
  off = installInputModality();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const fn = vi.fn();
  const { getByTestId } = render(<Box r={fn} />);
  expect(fn).toHaveBeenCalledWith(getByTestId("n"));
  expect(getByTestId("n")).not.toHaveAttribute("data-instant");
});

test("identity is stable across re-renders while the ref is, and clears to null on unmount", () => {
  const fn = vi.fn();
  const seen: boolean[] = [];
  const { rerender, unmount } = render(<Probe r={fn} seen={seen} />);
  rerender(<Probe r={fn} seen={seen} />);
  expect(seen).toEqual([true, true]);
  expect(fn).toHaveBeenCalledTimes(1);
  unmount();
  expect(fn).toHaveBeenLastCalledWith(null);
});
