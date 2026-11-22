import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import type { ToolRow } from "./rows";
import { RowHarness, rowToggle, toolRow } from "./tools/test-row";

beforeEach(() => resetSeq());

const agentWith = (task: NonNullable<ToolRow["backgroundTask"]>): ToolRow => ({
  ...toolRow("Agent", { description: "scan the repo" }, { content: "Async agent launched" }),
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
