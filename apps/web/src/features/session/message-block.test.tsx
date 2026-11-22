import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { ClampedMarkdown } from "./message-block";
import { type StickToBottom, useStickToBottom } from "./stick-to-bottom";

const para = (i: number) => `Paragraph ${i} ${"w".repeat(290)}`;
/** 20 paragraphs of 300 rendered characters: over 4,000 characters, well under 40 lines. */
const long = Array.from({ length: 20 }, (_, i) => para(i)).join("\n\n");

test("a body over 4,000 rendered characters clamps at a block boundary with Show all", () => {
  render(<ClampedMarkdown source={long} />);
  expect(screen.getByText(para(12))).toBeInTheDocument();
  expect(screen.queryByText(para(13))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(screen.getByText(para(19))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

test("a short body has no Show all", () => {
  render(<ClampedMarkdown source="hello" />);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

function InLog({ api }: { api: { current?: StickToBottom } }) {
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  api.current = useStickToBottom(scroller, log);
  return (
    <div ref={scroller}>
      <div role="log" ref={log}>
        <div data-row="r" tabIndex={-1}>
          <ClampedMarkdown source={long} />
        </div>
      </div>
    </div>
  );
}

test("Show all anchors its row through the timeline's expandAnchor before it expands", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  try {
    const api: { current?: StickToBottom } = {};
    render(<InLog api={api} />);
    const expandAnchor = vi.spyOn(api.current as StickToBottom, "expandAnchor");
    let clampedWhenAnchored: boolean | undefined;
    expandAnchor.mockImplementation(() => {
      clampedWhenAnchored = screen.queryByText(para(19)) === null;
    });
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(expandAnchor).toHaveBeenCalledWith(document.querySelector('[data-row="r"]'));
    expect(clampedWhenAnchored).toBe(true);
    expect(screen.getByText(para(19))).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});
