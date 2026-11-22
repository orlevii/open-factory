import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import type { Row, ToolRow } from "./rows";
import { Timeline } from "./timeline";
import { RowHarness, rowToggle, toolRow } from "./tools/test-row";

beforeEach(() => resetSeq());

// Agent calls are subagent cards now (U3 §12); any other call row still carries its task.
const agentWith = (task: NonNullable<ToolRow["backgroundTask"]>): ToolRow => ({
  ...toolRow("Monitor", { description: "watch the build" }, { content: "Watching" }),
  backgroundTask: task,
});

test("a background task shows on any call row it attaches to, not only Bash (U3 §9.5)", () => {
  const { unmount } = render(<RowHarness row={agentWith({ taskId: "b", state: "running" })} />);
  expect(within(rowToggle()).getByText("In background")).toHaveClass("shrink-0");
  unmount();
  render(
    <RowHarness row={agentWith({ taskId: "b", state: "failed", summary: "Agent crashed" })} />,
  );
  expect(within(rowToggle()).getByText("Failed")).toBeInTheDocument();
  const detail = screen.getByText("Agent crashed");
  expect(rowToggle()).not.toContainElement(detail);
  expect(detail).toHaveClass("line-clamp-2");
});

test("a finished task on an MCP call: 'Finished' with the summary on the detail line", () => {
  render(
    <RowHarness
      row={{
        ...toolRow("mcp__srv__watch", { path: "src" }, { content: "watching" }),
        backgroundTask: { taskId: "b", state: "finished", summary: "No changes" },
      }}
    />,
  );
  expect(within(rowToggle()).getByText("Finished")).toBeInTheDocument();
  expect(screen.getByText("No changes")).toBeInTheDocument();
});

// Keyboard reach inside a tool body (the body is the row button's sibling, not its descendant).
function TimelineOf({ rows }: { rows: Row[] }) {
  return (
    <Timeline
      slug="dev"
      rows={rows}
      failedIds={new Set()}
      interruptedEnds={new Set()}
      hasMoreBefore={false}
      onLoadEarlier={async () => false}
      earlierError={false}
      footer={null}
    />
  );
}
const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

test("in the timeline, Tab from an open tool row reaches 'Show all', and activating it keeps focus on the row", async () => {
  const user = userEvent.setup();
  const row = toolRow("Bash", { command: "seq 30" }, { content: longOutput });
  render(<TimelineOf rows={[row]} />);
  const rowButton = document.querySelector<HTMLElement>(`[data-row="${row.key}"]`) as HTMLElement;
  await user.click(rowButton);
  expect(rowButton).toHaveFocus();
  const showAll = screen.getByRole("button", { name: "Show all 30 lines" });
  expect(showAll).toHaveAttribute("tabindex", "0");
  await user.tab();
  expect(showAll).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", { name: "Show all 30 lines" })).toBeNull();
  expect(rowButton).toHaveFocus();
});

test("Esc on a control inside a tool body returns focus to its row; another row's body stays out of the tab order", async () => {
  const user = userEvent.setup();
  resetSeq();
  const a = toolRow("Bash", { command: "seq 30" }, { content: longOutput });
  const b = {
    ...toolRow("Bash", { command: "seq 30" }, { content: longOutput }),
    seq: 9,
    key: "9",
  };
  render(
    <TimelineOf
      rows={[a, { kind: "text", seq: 5, at: a.at, text: "between", key: "5", head: false }, b]}
    />,
  );
  const rowA = document.querySelector<HTMLElement>(`[data-row="${a.key}"]`) as HTMLElement;
  const rowB = document.querySelector<HTMLElement>('[data-row="9"]') as HTMLElement;
  await user.click(rowA);
  await user.click(rowB);
  const [showA, showB] = screen.getAllByRole("button", { name: "Show all 30 lines" });
  expect(showA).toHaveAttribute("tabindex", "-1");
  expect(showB).toHaveAttribute("tabindex", "0");
  act(() => showB?.focus());
  await user.keyboard("{Escape}");
  expect(rowB).toHaveFocus();
});

test("Show all in a tool body keeps the view still: the row takes focus without scrolling to it", async () => {
  const user = userEvent.setup();
  resetSeq();
  const row = toolRow("Bash", { command: "seq 30" }, { content: longOutput });
  render(<TimelineOf rows={[row]} />);
  const rowButton = document.querySelector<HTMLElement>(`[data-row="${row.key}"]`) as HTMLElement;
  await user.click(rowButton);
  // The header is above the view: only the end of the output is on screen.
  const scroller = document.querySelector('[role="log"]')?.parentElement as HTMLElement;
  scroller.scrollTop = 1744;
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await user.click(screen.getByRole("button", { name: "Show all 30 lines" }));
  expect(rowButton).toHaveFocus();
  const onRow = focus.mock.calls.filter((_, i) => focus.mock.contexts[i] === rowButton);
  expect(onRow.length).toBeGreaterThan(0);
  for (const args of onRow) expect(args[0]).toEqual({ preventScroll: true });
  expect(scroller.scrollTop).toBe(1744);
  focus.mockRestore();
});

test("Esc on a row's ⋯ returns focus to its row, a call's in a folded run included", async () => {
  const user = userEvent.setup();
  resetSeq();
  const row = toolRow("Bash", { command: "ls" }, { content: "a" });
  render(<TimelineOf rows={[row]} />);
  const rowButton = document.querySelector<HTMLElement>(`[data-row="${row.key}"]`) as HTMLElement;
  await user.click(rowButton);
  const menu = screen.getByRole("button", { name: "Row actions", hidden: true });
  act(() => menu.focus());
  await user.keyboard("{Escape}");
  expect(rowButton).toHaveFocus();
});
