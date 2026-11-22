import { render, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

// A diagram renders only if mermaid is ever asked to: the mock answers at once with a marker.
const mermaidRender = vi.hoisted(() =>
  vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' })),
);
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: mermaidRender } }));

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

test("the summary's argument prefers title, name, query, description, path, url over key order (D4)", () => {
  // As stored: jsonb orders keys by length, so `base` comes before `title`.
  const input = { base: "main", head: "fix/retry", title: "Fix the retry loop", url: "https://x" };
  const { unmount } = render(<RowHarness row={toolRow(NAME, input, { content: "ok" })} />);
  expect(rowToggle()).toHaveTextContent(/Fix the retry loop$/);
  unmount();
  render(
    <RowHarness
      row={toolRow(NAME, { base: "main", path: "src/a.ts", query: "retry" }, { content: "ok" })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/retry$/);
});

test("expanded: the preferred keys lead the input list, the rest keep their order", () => {
  const { container } = render(
    <RowHarness
      open
      row={toolRow(NAME, { base: "main", head: "x", title: "T", body: "B" }, { content: "ok" })}
    />,
  );
  const terms = within(container.querySelector("dl") as HTMLElement)
    .getAllByRole("term")
    .map((t) => t.textContent);
  expect(terms).toEqual(["title", "base", "head", "body"]);
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

test("expanded: a text result is outside content: a mermaid fence stays code", async () => {
  const { container } = render(
    <RowHarness
      open
      row={toolRow(NAME, { title: "x" }, { content: "```mermaid\ngraph TD; A-->B\n```" })}
    />,
  );
  expect(container.querySelector("pre > code")).toHaveTextContent("graph TD; A-->B");
  await new Promise((r) => setTimeout(r, 20));
  expect(container.querySelector(".md-diagram")).toBeNull();
  expect(mermaidRender).not.toHaveBeenCalled();
});
