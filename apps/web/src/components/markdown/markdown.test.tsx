import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

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

// Shiki's Oniguruma WASM engine can't start under jsdom (its Blob has no .stream()),
// so the highlighter is mocked here. The real lazy load is covered by the build.
// An unknown language ("nope") rejects, as real Shiki does.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string, opts: { lang: string }) => {
    if (opts.lang === "nope") throw new Error("Language `nope` not found");
    return `<pre class="shiki"><code>${code}</code></pre>`;
  }),
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
