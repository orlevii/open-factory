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

test("the server splits into a head and its last 6 characters, never narrower than 4 of the head plus the tail", () => {
  const { container } = render(<McpName name="mcp__github-cloud-connector__create_pull_request" />);
  const { server } = parts(container);
  expect(server).toHaveTextContent(/^github-cloud-connector$/);
  const [head, tail] = [...server.children] as HTMLElement[];
  expect(head?.textContent).toBe("github-cloud-con");
  expect(tail?.textContent).toBe("nector");
  // The server never goes below its head's 4 characters plus its 6-character tail.
  expect(server.style.minWidth).toBe("calc(10ch + 1px)");
});

test("' · ' sits between the server and the tool", () => {
  const { container } = render(<McpName name="mcp__github-cloud-connector__create_pull_request" />);
  const { server, tool } = parts(container);
  const sep = container.querySelector("[data-mcp-sep]") as HTMLElement;
  expect(sep.textContent).toBe(" · ");
  expect(sep.previousElementSibling).toBe(server);
  expect(sep.nextElementSibling).toBe(tool);
  expect(tool.textContent).toBe("create_pull_request");
});

test("the tool cuts from its start: a right-to-left box around left-to-right text", () => {
  const { container } = render(<McpName name="mcp__github__create_pull_request_review" />);
  const { tool } = parts(container);
  expect(tool).toHaveAttribute("dir", "rtl");
  // The text itself stays left-to-right inside the right-to-left box.
  expect(tool.firstElementChild).toHaveAttribute("dir", "ltr");
  expect(tool).toHaveTextContent(/^create_pull_request_review$/);
});

test("a short server never shrinks", () => {
  const { container } = render(<McpName name="mcp__gh__create_pull_request" />);
  const { server } = parts(container);
  // No least width: only a head longer than 4 characters gives way.
  expect(server.style.minWidth).toBe("");
});

test("a one-letter server and a server-only name do not break", () => {
  const { container } = render(<McpName name="mcp__x" />);
  expect(container).toHaveTextContent(/^x$/);
  expect(parts(container).tool).toBeNull();
});

test("a non-MCP name renders as itself", () => {
  const { container } = render(<McpName name="Bash" />);
  expect(container).toHaveTextContent(/^Bash$/);
});
