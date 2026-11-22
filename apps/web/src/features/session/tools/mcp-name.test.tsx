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

test("the server middle-truncates: its head shrinks to at least 3 characters and an ellipsis; its last 6 stay", () => {
  const { container } = render(<McpName name="mcp__github-cloud-connector__create_pull_request" />);
  const { server } = parts(container);
  expect(server).toHaveTextContent(/^github-cloud-connector$/);
  const [head, tail] = [...server.children] as HTMLElement[];
  expect(head?.textContent).toBe("github-cloud-con");
  expect(head).toHaveClass("truncate");
  // 3 characters and the ellipsis, at least.
  expect(head?.style.minWidth).toBe("calc(4ch + 1px)");
  expect(tail?.textContent).toBe("nector");
  expect(tail).toHaveClass("shrink-0");
  // The server gives way first, never below its head's 4 characters plus its 6-character tail.
  expect(server).toHaveClass("shrink-[100]");
  expect(server.style.minWidth).toBe("calc(10ch + 1px)");
});

test("the separator sits outside the tool's truncation, so ' · ' always shows between the two", () => {
  const { container } = render(<McpName name="mcp__github-cloud-connector__create_pull_request" />);
  const { server, tool } = parts(container);
  const sep = container.querySelector("[data-mcp-sep]") as HTMLElement;
  expect(sep.textContent).toBe(" · ");
  expect(sep).toHaveClass("shrink-0");
  expect(sep.previousElementSibling).toBe(server);
  expect(sep.nextElementSibling).toBe(tool);
  expect(tool.textContent).toBe("create_pull_request");
});

test("the tool keeps its tail: it shrinks after the server, and cuts from its start", () => {
  const { container } = render(<McpName name="mcp__github__create_pull_request_review" />);
  const { tool } = parts(container);
  expect(tool).toHaveClass("min-w-0", "truncate");
  expect(tool).toHaveAttribute("dir", "rtl");
  // The text itself stays left-to-right inside the right-to-left box.
  expect(tool.firstElementChild).toHaveAttribute("dir", "ltr");
  expect(tool).toHaveTextContent(/^create_pull_request_review$/);
});

test("a short server never shrinks", () => {
  const { container } = render(<McpName name="mcp__gh__create_pull_request" />);
  const { server } = parts(container);
  expect(server).toHaveClass("shrink-0");
  expect(server.querySelector(".truncate")).toBeNull();
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
