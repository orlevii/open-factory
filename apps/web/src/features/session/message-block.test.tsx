import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import { ClampedMarkdown, MessageBlock } from "./message-block";
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

const fence = (n: number) =>
  `Run this:\n\n\`\`\`\n${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n\`\`\``;

test("a queued (brief) body with a code block is cut before rendering and capped at three lines; Show all reveals it", () => {
  render(<MessageBlock from="@alice" body={fence(2000)} brief queued={{}} />);
  const body = document.querySelector("[data-message-body]") as HTMLElement;
  // The pre never escapes the clamp: the source is cut, and a code block is capped at three 24px lines.
  const box = body.querySelector(".line-clamp-3") as HTMLElement;
  expect(box).toHaveClass("[&_pre]:max-h-[4.5rem]", "[&_pre]:overflow-hidden");
  expect(screen.queryByText(/line 1999/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(screen.getByText(/line 1999/)).toBeInTheDocument();
  expect(body.querySelector(".line-clamp-3")).toBeNull();
});

test("a short queued body has no Show all", () => {
  render(<MessageBlock from="@alice" body="hello" brief queued={{}} />);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
});

test("Show all moves focus to its row without scrolling it into view (nothing above moves)", () => {
  render(
    <div data-row="r" tabIndex={-1}>
      <ClampedMarkdown source={long} />
    </div>,
  );
  const row = document.querySelector<HTMLElement>('[data-row="r"]') as HTMLElement;
  const focus = vi.spyOn(row, "focus");
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

const notice = (body: string) => (
  <MessageBlock from="@factory" system body={body} at="2026-11-19T10:00:00Z" />
);

test("once layout has measured a notice, the measurement decides: a long notice that fits has no Show all", () => {
  const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(48);
  const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(48);
  try {
    render(notice(`A wide pane fits this. ${"word ".repeat(60)}`));
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  } finally {
    sh.mockRestore();
    ch.mockRestore();
  }
});

test("a notice keeps its soft line breaks", () => {
  render(notice("@or assigned you T-1\nThe task, written by @or"));
  const box = document.querySelector("[data-notice] .line-clamp-2") as HTMLElement;
  expect(box).toHaveClass("[&_p]:whitespace-pre-line");
});

test("once layout has measured it, a queued body with a short code block still offers Show all (the capped plate hides lines)", () => {
  const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(72);
  const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(72);
  try {
    render(<MessageBlock from="@alice" body={fence(6)} brief queued={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText(/line 5/)).toBeInTheDocument();
  } finally {
    sh.mockRestore();
    ch.mockRestore();
  }
});

test("a measured code plate that overflows its cap offers Show all", () => {
  const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === "PRE" ? 200 : 72;
  });
  const ch = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(72);
  try {
    // Two long code lines: within the box's line count, but wider plates wrap nothing; the plate measures over.
    render(<MessageBlock from="@alice" body={"```\na\nb\n```"} brief queued={{}} />);
    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
  } finally {
    sh.mockRestore();
    ch.mockRestore();
  }
});
