import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

// Counts ReactMarkdown calls while still rendering for real, so the other tests keep their output.
const markdownCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Counting: typeof actual.default = (props) => {
    markdownCalls.n++;
    return actual.default(props);
  };
  return { ...actual, default: Counting };
});

// "bad" sources fail with a multi-line parser-style error; "slow" sources never resolve.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => {
      if (source.includes("bad"))
        throw new Error(`Parse error on line 1:\n${"-".repeat(300)}\nExpecting 'NODE'`);
      if (source.includes("slow")) return new Promise(() => {});
      return { svg: '<svg data-testid="mermaid-svg"></svg>' };
    }),
  },
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
  expect(a).toHaveAccessibleDescription("Opens in a new tab");
});

test("internal links have no new-tab note", () => {
  render(<Markdown source={"[y](/inbox)"} />);
  const a = screen.getByRole("link", { name: "y" });
  expect(a).not.toHaveAttribute("target");
  expect(a).not.toHaveAccessibleDescription();
});

test("tables are wrapped so wide ones scroll on their own", () => {
  render(<Markdown source={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
  expect(screen.getByRole("table").parentElement).toHaveClass("md-table");
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
  // Real Shiki (JavaScript regex engine) with both themes as CSS variables.
  await waitFor(() =>
    expect(container.querySelector("pre.shiki.github-light.github-dark")).toBeInTheDocument(),
  );
  expect(container.querySelector("pre.shiki")).toHaveTextContent("const a = 1;");
});

test("renders mermaid blocks with strict security", async () => {
  render(<Markdown source={"```mermaid\ngraph TD; A-->B\n```"} />);
  await waitFor(() => expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument());
  // The diagram sits on the light "paper" card in both color schemes.
  expect(screen.getByTestId("mermaid-svg").parentElement).toHaveClass("md-diagram");
  const mermaid = (await import("mermaid")).default;
  expect(mermaid.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: "strict" }),
  );
});

test("javascript: links are not rendered as executable hrefs", () => {
  render(<Markdown source={"[x](javascript:alert(1))"} />);
  const a = screen.getByText("x").closest("a");
  expect(a?.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
});

test("an invalid mermaid diagram shows a short error note and the source", async () => {
  const { container } = render(<Markdown source={"```mermaid\nbad graph\n```"} />);
  expect(await screen.findByText("Couldn't render this diagram.")).toBeInTheDocument();
  // Only the parser's first line, capped, follows the note.
  const detail = screen.getByText(/^Parse error on line 1:/);
  expect(detail).toHaveTextContent(/^Parse error on line 1:$/);
  expect(detail.textContent?.length).toBeLessThanOrEqual(120);
  expect(container.querySelector("pre")).toHaveTextContent("bad graph");
});

test("mermaid state follows the source: valid -> invalid -> valid", async () => {
  const doc = (s: string) => `\`\`\`mermaid\n${s}\n\`\`\``;
  const { rerender } = render(<Markdown source={doc("graph TD; A-->B")} />);
  await screen.findByTestId("mermaid-svg");
  rerender(<Markdown source={doc("bad graph")} />);
  await screen.findByText("Couldn't render this diagram.");
  expect(screen.queryByTestId("mermaid-svg")).toBeNull();
  rerender(<Markdown source={doc("graph TD; B-->C")} />);
  await screen.findByTestId("mermaid-svg");
  expect(screen.queryByText("Couldn't render this diagram.")).toBeNull();
});

test("a stale mermaid diagram is dropped while the new source renders", async () => {
  const doc = (s: string) => `\`\`\`mermaid\n${s}\n\`\`\``;
  const { rerender, container } = render(<Markdown source={doc("graph TD; A-->B")} />);
  await screen.findByTestId("mermaid-svg");
  rerender(<Markdown source={doc("graph TD; slow")} />);
  await waitFor(() => expect(screen.queryByTestId("mermaid-svg")).toBeNull());
  expect(container.querySelector("pre")).toHaveTextContent("graph TD; slow");
});

test("a code block switching to an unknown language drops the old highlight", async () => {
  const { rerender, container } = render(<Markdown source={"```ts\nconst a = 1;\n```"} />);
  await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
  rerender(<Markdown source={"```nope\nother code\n```"} />);
  await waitFor(() => expect(container.querySelector("pre.shiki")).toBeNull());
  expect(container.querySelector("pre")).toHaveTextContent("other code");
});

test("variant detail wraps in .prose-of-detail, the default does not", () => {
  const { container, rerender } = render(<Markdown source="# A" variant="detail" />);
  expect(container.querySelector(".prose-of-detail")).not.toBeNull();
  rerender(<Markdown source="# A" />);
  expect(container.querySelector(".prose-of-detail")).toBeNull();
});

test("variant work is a modifier on .prose-of (tool output), never the detail scale", () => {
  const { container } = render(<Markdown source="# A" variant="work" />);
  const root = container.firstElementChild;
  expect(root).toHaveClass("prose-of", "prose-of-work");
  expect(root).not.toHaveClass("prose-of-detail");
});

test("re-rendering the parent with the same source does not parse again", () => {
  const { rerender } = render(<Markdown source="**same**" variant="detail" />);
  const after = markdownCalls.n;
  rerender(<Markdown source="**same**" variant="detail" />);
  expect(markdownCalls.n).toBe(after);
  rerender(<Markdown source="**same**" />);
  expect(markdownCalls.n).toBe(after + 1);
});

test("block elements take their own direction (dir=auto), so a right-to-left paragraph reads right", () => {
  const { container } = render(
    <Markdown source={"# כותרת\n\nשלום עולם\n\n- item\n- [x] done\n\n> quote"} />,
  );
  for (const sel of ["h1", "p", "li", "blockquote"])
    expect(container.querySelector(sel)).toHaveAttribute("dir", "auto");
  expect(container.querySelector("li.task-list-item")).not.toBeNull();
});
