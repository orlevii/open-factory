import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetSeq } from "@/test/session-fixtures";
import { RowHarness, rowToggle, toolRow } from "./test-row";

beforeEach(() => resetSeq());

const fetchRow = (url: unknown, content?: string, isError = false) =>
  toolRow(
    "WebFetch",
    { url, prompt: "Summarize the retry policy" },
    content === undefined ? undefined : { content, isError },
  );

test("collapsed: host and path, no scheme or query", () => {
  render(<RowHarness row={fetchRow("https://docs.example.com/guides/retry?x=1#top", "ok")} />);
  expect(rowToggle()).toHaveTextContent(/^docs\.example\.com\/guides\/retry$/);
});

test("collapsed: a URL that does not parse shows as given", () => {
  render(<RowHarness row={fetchRow("not a url", "ok")} />);
  expect(rowToggle()).toHaveTextContent(/^not a url$/);
});

test("expanded: the prompt, then the result as tool-output markdown", () => {
  const { container } = render(
    <RowHarness
      open
      row={fetchRow("https://example.com/a", "## Retries\n\nThree **attempts**.")}
    />,
  );
  expect(screen.getByText("Summarize the retry policy")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Retries" })).toBeInTheDocument();
  expect(container.querySelector(".prose-of-work")).toBeInTheDocument();
  expect(container.querySelector("strong")).toHaveTextContent("attempts");
});

test("expanded: links in the result open safely; raw HTML stays off", () => {
  const { container } = render(
    <RowHarness
      open
      row={fetchRow("https://example.com", "[home](https://evil.example)\n\n<script>x()</script>")}
    />,
  );
  expect(screen.getByRole("link", { name: "home" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(container.querySelector("script")).toBeNull();
});

test("a failed fetch shows its error output", () => {
  render(<RowHarness open row={fetchRow("https://example.com", "Request failed: 404", true)} />);
  expect(document.querySelector("pre")).toHaveTextContent("Request failed: 404");
});

test("WebSearch: the query", () => {
  render(
    <RowHarness
      row={toolRow("WebSearch", { query: "pg-boss retry backoff" }, { content: "results" })}
    />,
  );
  expect(rowToggle()).toHaveTextContent(/^pg-boss retry backoff$/);
});
