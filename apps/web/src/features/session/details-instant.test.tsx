import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CompactionMarker } from "./compaction-marker";
import { QuietLine } from "./quiet-line";

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.instant;
});

// Hold frames so the instant flag is observable after the click.
function holdFrames() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
}

const compacted = {
  type: "compacted",
  trigger: "auto",
  preTokens: 120_000,
  postTokens: 8_000,
  summary: "The summary",
} as unknown as Parameters<typeof CompactionMarker>[0]["event"];

const cases = [
  ["QuietLine", () => render(<QuietLine detail="stderr text">Exited</QuietLine>)],
  ["CompactionMarker", () => render(<CompactionMarker event={compacted} rowProps={{}} />)],
] as const;

for (const [name, mount] of cases) {
  test(`${name}: a keyboard toggle (detail 0) runs instant`, () => {
    holdFrames();
    const { container } = mount();
    const summary = container.querySelector("summary") as HTMLElement;
    fireEvent.click(summary, { detail: 0 });
    expect(document.documentElement.dataset.instant).toBe("");
  });

  test(`${name}: a pointer toggle (detail 1) keeps the transition`, () => {
    holdFrames();
    const { container } = mount();
    const summary = container.querySelector("summary") as HTMLElement;
    fireEvent.click(summary, { detail: 1 });
    expect(document.documentElement.dataset.instant).toBeUndefined();
  });
}

test("the summary still toggles its details", () => {
  holdFrames();
  render(<QuietLine detail="stderr text">Exited</QuietLine>);
  const details = screen.getByText("Exited").closest("details") as HTMLDetailsElement;
  fireEvent.click(details.querySelector("summary") as HTMLElement, { detail: 0 });
  expect(details.open).toBe(true);
});

test("a quiet line wraps an unbroken handle instead of painting past its card (390 at 200% text)", () => {
  render(<QuietLine>@long-handle-agent-yyyyyyyyyyyyyyyyyyyyyy</QuietLine>);
  expect(screen.getByText("@long-handle-agent-yyyyyyyyyyyyyyyyyyyyyy")).toHaveClass(
    "min-w-0",
    "[overflow-wrap:anywhere]",
  );
});
