import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { McpName } from "./mcp-name";

const parts = (container: HTMLElement) => {
  const server = container.querySelector("[data-mcp-server]") as HTMLElement;
  const tool = container.querySelector("[data-mcp-tool]") as HTMLElement;
  return { server, tool };
};

test("server · tool reads in full", () => {
  const { container } = render(<McpName name="mcp__claude_ai_Google_Drive__search_files" />);
  expect(container).toHaveTextContent(/^claude_ai_Google_Drive · search_files$/);
});

test("the server middle-truncates: its head shrinks first to an ellipsis, then its tail ends in one", () => {
  const { container } = render(<McpName name="mcp__claude_ai_Google_Drive__search_files" />);
  const { server } = parts(container);
  expect(server).toHaveTextContent("claude_ai_Google_Drive");
  const [head, tail] = [...server.children] as HTMLElement[];
  expect(head?.textContent).toBe("claude_ai_G");
  expect(head).toHaveClass("truncate", "min-w-[1ch]", "shrink-[100]");
  expect(tail?.textContent).toBe("oogle_Drive");
  expect(tail).toHaveClass("min-w-0", "truncate");
});

test("at narrow widths a long server keeps a minimum width and gives way before the tool (D3 at 320)", () => {
  const { container } = render(<McpName name="mcp__github-cloud-connector__create_pull_request" />);
  const { server, tool } = parts(container);
  // It never collapses to nothing: 8 characters stay, ellipses included.
  expect(server).toHaveClass("min-w-[8ch]", "shrink-[100]");
  // The tool shrinks only after the server reached its minimum, from its start.
  expect(tool).toHaveClass("min-w-0", "truncate");
  expect(tool).not.toHaveClass("shrink-0");
  // A server shorter than that never shrinks.
  const short = render(<McpName name="mcp__gh__create_pull_request" />).container;
  expect(parts(short).server).toHaveClass("shrink-0");
  expect(parts(short).server).not.toHaveClass("min-w-[8ch]");
});

test("the tool keeps its tail: it shrinks after the server, and cuts from its start", () => {
  const { container } = render(<McpName name="mcp__github__create_pull_request_review" />);
  const { tool } = parts(container);
  expect(tool).toHaveClass("min-w-0", "truncate");
  expect(tool).toHaveAttribute("dir", "rtl");
  // The text itself stays left-to-right inside the right-to-left box.
  expect(tool.firstElementChild).toHaveAttribute("dir", "ltr");
  expect(tool).toHaveTextContent(/^· create_pull_request_review$/);
});

test("a one-letter server and a server-only name do not break", () => {
  const { container } = render(<McpName name="mcp__x" />);
  expect(container).toHaveTextContent(/^x$/);
  expect(parts(container).tool).toBeNull();
});

test("a non-MCP name end-truncates as itself", () => {
  const { container } = render(<McpName name="Bash" />);
  expect(container.firstElementChild).toHaveClass("truncate");
  expect(container).toHaveTextContent(/^Bash$/);
});
