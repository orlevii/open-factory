import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

test("create_task: a quiet line with the new task's badge and title", () => {
  render(
    <RowHarness
      row={toolRow(
        "mcp__factory__create_task",
        { title: "Review config change" },
        { content: '{"key":"T-7","status":"todo","blocked_by":[]}' },
      )}
    />,
  );
  const row = rowToggle();
  expect(row).toHaveTextContent(/^Create taskT-7·Review config change$/);
  expect(within(row).getByText("Create task")).toHaveClass("text-muted-foreground");
  expect(within(row).getByText("T-7")).toHaveClass("font-mono");
  expect(within(row).queryByRole("link")).not.toBeInTheDocument();
});

test("create_task while running: no key yet, the title alone", () => {
  render(
    <RowHarness row={toolRow("mcp__factory__create_task", { title: "Review config change" })} />,
  );
  expect(rowToggle()).toHaveTextContent(/^Create taskReview config changeRunning$/);
});

test("update_task: the key from the input", () => {
  render(
    <RowHarness
      row={toolRow(
        "mcp__factory__update_task",
        { id: "T-42", status: "done" },
        { content: '{"key":"T-42"}' },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^Update taskT-42$/);
});

test("comment_task with a bare number reads as its T- key", () => {
  render(
    <RowHarness
      row={toolRow("mcp__factory__comment_task", { id: "42", body: "Done" }, { content: "{}" })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^Comment on taskT-42$/);
});

test("schedule_message: the S- key from the result", () => {
  render(
    <RowHarness
      row={toolRow(
        "mcp__factory__schedule_message",
        { body: "Standup", cron: "0 9 * * 1-5" },
        { content: '{"id":"S-3","next":"2026-11-23T09:00:00Z"}' },
      )}
    />,
  );
  const row = rowToggle();
  expect(row).toHaveTextContent(/^Schedule messageS-3$/);
  expect(within(row).getByText("S-3")).toHaveClass("font-mono");
});

test("cancel_schedule: the key from the input", () => {
  render(
    <RowHarness row={toolRow("mcp__factory__cancel_schedule", { id: "S-3" }, { content: "{}" })} />,
  );
  expect(rowToggle()).toHaveTextContent(/^Cancel scheduleS-3$/);
});

test("list_tasks: the quiet line alone; the body stays the generic one", () => {
  render(
    <RowHarness
      open
      row={toolRow("mcp__factory__list_tasks", { status: "todo" }, { content: '{"tasks":[]}' })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^List tasks$/);
  expect(screen.getByText('{"tasks":[]}')).toBeInTheDocument();
});

test("a result that is not JSON never throws", () => {
  render(
    <RowHarness
      row={toolRow("mcp__factory__create_task", { title: "x" }, { content: "ok: delivered" })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^Create taskx$/);
});
