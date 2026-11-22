import { render, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

const NAME = "mcp__linear__create_issue";

test("collapsed: server · tool, then the first string argument muted", () => {
  render(
    <RowHarness
      row={toolRow(NAME, { team: 3, title: "Fix the retry loop", body: "Long" }, { content: "ok" })}
    />,
  );
  const row = rowToggle();
  expect(row).toHaveTextContent(/^linear · create_issueFix the retry loop$/);
  expect(within(row).getByText("Fix the retry loop")).toHaveClass("text-muted-foreground");
  expect(within(row).getByTitle(NAME)).toBeInTheDocument();
});

test("expanded: the input as a key/value list", () => {
  const { container } = render(
    <RowHarness
      open
      row={toolRow(NAME, { title: "Fix it", priority: 2, labels: ["bug"] }, { content: "Done" })}
    />,
  );
  const list = container.querySelector("dl") as HTMLElement;
  const terms = within(list)
    .getAllByRole("term")
    .map((t) => t.textContent);
  expect(terms).toEqual(["title", "priority", "labels"]);
  const values = within(list)
    .getAllByRole("definition")
    .map((d) => d.textContent);
  expect(values).toEqual(["Fix it", "2", '["bug"]']);
});

test("expanded: a text result renders as tool-output markdown", () => {
  const { container } = render(
    <RowHarness
      open
      row={toolRow(NAME, { title: "x" }, { content: "Created **ENG-12**: Fix it" })}
    />,
  );
  expect(container.querySelector(".prose-of-work strong")).toHaveTextContent("ENG-12");
});

test("expanded: a JSON result stays text in a plate", () => {
  const { container } = render(
    <RowHarness open row={toolRow(NAME, { title: "x" }, { content: '{"id":"ENG-12","n":1}' })} />,
  );
  expect(container.querySelector(".prose-of-work")).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent('"id": "ENG-12"');
});

test("an input that is not an object still renders", () => {
  render(<RowHarness open row={toolRow(NAME, "raw", { content: "ok" })} />);
  expect(rowToggle()).toHaveTextContent(/^linear · create_issue/);
});

test("other factory tools (not task or schedule) render as MCP tools", () => {
  render(<RowHarness row={toolRow("mcp__factory__list_peers", {}, { content: "[]" })} />);
  expect(rowToggle()).toHaveTextContent(/^factory · list_peers$/);
});
