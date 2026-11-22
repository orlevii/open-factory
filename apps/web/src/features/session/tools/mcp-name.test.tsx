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

test("the server middle-truncates: its head shrinks with an ellipsis, its tail stays", () => {
  const { container } = render(<McpName name="mcp__claude_ai_Google_Drive__search_files" />);
  const { server } = parts(container);
  expect(server).toHaveTextContent("claude_ai_Google_Drive");
  expect(server).toHaveClass("min-w-0", "overflow-hidden");
  const [head, tail] = [...server.children] as HTMLElement[];
  expect(head?.textContent).toBe("claude_ai_G");
  expect(head).toHaveClass("min-w-0", "truncate");
  expect(tail?.textContent).toBe("oogle_Drive");
  expect(tail).toHaveClass("shrink-0");
  expect(tail).not.toHaveClass("truncate");
});

test("the tool keeps its tail: it never shrinks before the server, and cuts from its start", () => {
  const { container } = render(<McpName name="mcp__github__create_pull_request_review" />);
  const { tool } = parts(container);
  expect(tool).toHaveClass("shrink-0", "max-w-full", "truncate");
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
