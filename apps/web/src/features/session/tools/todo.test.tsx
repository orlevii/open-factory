import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

const todos = [
  { content: "Read the spec", status: "completed", activeForm: "Reading the spec" },
  { content: "Write tests", status: "completed", activeForm: "Writing tests" },
  { content: "Implement", status: "completed", activeForm: "Implementing" },
  { content: "Run the suite", status: "in_progress", activeForm: "Running the suite" },
  { content: "Typecheck", status: "pending", activeForm: "Typechecking" },
  { content: "Lint", status: "pending", activeForm: "Linting" },
  { content: "Commit", status: "pending", activeForm: "Committing" },
];
const RESULT = "Todos have been modified successfully.";

test("collapsed: Updated plan · 3/7 done", () => {
  render(<RowHarness row={toolRow("TodoWrite", { todos }, { content: RESULT })} />);
  expect(rowToggle()).toHaveTextContent(/^Updated plan · 3\/7 done$/);
});

test("expanded: the checklist from the input, read-only, each item's state in words", () => {
  render(<RowHarness open row={toolRow("TodoWrite", { todos }, { content: RESULT })} />);
  const items = screen.getAllByRole("listitem");
  expect(items.map((i) => i.textContent)).toEqual([
    "Done: Read the spec",
    "Done: Write tests",
    "Done: Implement",
    "In progress: Run the suite",
    "To do: Typecheck",
    "To do: Lint",
    "To do: Commit",
  ]);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: /Run the suite/ })).not.toBeInTheDocument();
  expect(screen.queryByText(RESULT)).not.toBeInTheDocument();
});

test("an input without todos still reads Updated plan", () => {
  render(<RowHarness open row={toolRow("TodoWrite", { todos: "nope" }, { content: RESULT })} />);
  expect(rowToggle()).toHaveTextContent(/^Updated plan$/);
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
});

test("malformed items are skipped", () => {
  render(
    <RowHarness
      open
      row={toolRow(
        "TodoWrite",
        { todos: [null, { content: "Ok", status: "completed" }, { status: "pending" }] },
        { content: RESULT },
      )}
    />,
  );
  expect(rowToggle()).toHaveTextContent("Updated plan · 1/1 done");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
});
