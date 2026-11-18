import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-svg"></svg>' })),
  },
}));

// Shiki's Oniguruma WASM engine can't start under jsdom (its Blob has no .stream()),
// so the highlighter is mocked here. The real lazy load is covered by the build.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

test("renders GFM tables and task lists", () => {
  render(<Markdown source={"| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"} />);
  expect(screen.getByRole("table")).toBeInTheDocument();
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).toBeChecked();
});

test("does not render raw HTML or scripts", () => {
  const { container } = render(<Markdown source={'<script>alert(1)</script><b id="x">bold</b>'} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("#x")).toBeNull();
});

test("external links open safely", () => {
  render(<Markdown source={"[x](https://example.com)"} />);
  const a = screen.getByRole("link", { name: "x" });
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
});

test("unlabeled fenced blocks render inside <pre>, inline code does not", () => {
  const { container } = render(<Markdown source={"Use `x` here.\n\n```\nplain block\n```"} />);
  const pre = container.querySelector("pre");
  expect(pre).toBeInTheDocument();
  expect(pre).toHaveTextContent("plain block");
  const inline = screen.getByText("x");
  expect(inline.tagName).toBe("CODE");
  expect(inline.closest("pre")).toBeNull();
});

test("highlights code blocks once shiki loads", async () => {
  const { container } = render(<Markdown source={"```ts\nconst a = 1;\n```"} />);
  expect(container.querySelector("pre")).toBeInTheDocument();
  await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
  const { codeToHtml } = await import("shiki");
  expect(codeToHtml).toHaveBeenCalledWith(
    "const a = 1;",
    expect.objectContaining({ lang: "ts", themes: { light: "github-light", dark: "github-dark" } }),
  );
});

test("renders mermaid blocks with strict security", async () => {
  render(<Markdown source={"```mermaid\ngraph TD; A-->B\n```"} />);
  await waitFor(() => expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument());
  const mermaid = (await import("mermaid")).default;
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict" }),
  );
});
