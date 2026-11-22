import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
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

describe("images never load (U3 §9.3)", () => {
  test.each(["default", "detail", "work"] as const)(
    "%s: an image is a link Image: alt, and no <img>",
    (variant) => {
      const { container } = render(
        <Markdown
          source={"See ![the chart](https://evil.example/x.png) here."}
          variant={variant}
        />,
      );
      expect(container.querySelector("img")).toBeNull();
      const a = screen.getByRole("link", { name: "Image: the chart" });
      expect(a).toHaveAttribute("href", "https://evil.example/x.png");
      expect(a).toHaveAttribute("target", "_blank");
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
    },
  );

  test("untrusted markdown too", () => {
    const { container } = render(
      <Markdown source={"![a](https://evil.example/x.png)"} untrusted />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Image: a" })).toBeInTheDocument();
  });

  test("an alt over 80 characters is cut to 80 with an ellipsis; the full alt is its title", () => {
    const alt = "x".repeat(120);
    render(<Markdown source={`![${alt}](https://evil.example/x.png)`} />);
    const a = screen.getByRole("link", { name: /^Image: x+…$/ });
    const shown = (a.textContent ?? "").replace(/^Image: /, "");
    expect(shown).toHaveLength(80);
    expect(a).toHaveAttribute("title", alt);
  });

  test("no alt: the host", () => {
    render(<Markdown source={"![](https://cdn.evil.example/a/b.png?x=1)"} />);
    expect(screen.getByRole("link", { name: "Image: cdn.evil.example" })).toBeInTheDocument();
  });

  test("a reference-style image is a link too", () => {
    const { container } = render(
      <Markdown source={"![logo][l]\n\n[l]: https://evil.example/l.png"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Image: logo" })).toBeInTheDocument();
  });

  test("an image inside a link stays inside one link", () => {
    const { container } = render(
      <Markdown source={"[![badge](https://evil.example/b.svg)](https://example.com)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("a a")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Image: badge" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

  test("a javascript: image source is not a link", () => {
    const { container } = render(<Markdown source={"![x](javascript:alert(1))"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByText("Image: x")).toBeInTheDocument();
  });
});

describe("untrusted markdown", () => {
  test("a mermaid fence renders as plain code, never a diagram", async () => {
    const mermaid = (await import("mermaid")).default;
    vi.mocked(mermaid.render).mockClear();
    const { container } = render(
      <Markdown source={"```mermaid\ngraph TD; A-->B\n```"} variant="work" untrusted />,
    );
    const code = container.querySelector("pre > code");
    expect(code).toHaveTextContent("graph TD; A-->B");
    expect(container.querySelector(".md-diagram")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("mermaid-svg")).not.toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  test("trusted markdown still renders mermaid", async () => {
    render(<Markdown source={"```mermaid\ngraph TD; A-->B\n```"} variant="work" />);
    await waitFor(() => expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument());
  });

  test("other fences still highlight", async () => {
    const { container } = render(<Markdown source={"```ts\nconst a = 1;\n```"} untrusted />);
    await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
  });
});

test("an upper-case HTTP:// link (or image) still opens safely in a new tab", () => {
  render(<Markdown source={"[x](HTTP://example.com) ![pic](HTTPS://evil.example/p.png)"} />);
  for (const name of ["x", "Image: pic"]) {
    const a = screen.getByRole("link", { name });
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("data: and protocol-relative image sources are plain text, never links or images", () => {
  const { container } = render(
    <Markdown source={"![d](data:image/png;base64,AAAA) ![p](//evil.example/p.png)"} />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container).toHaveTextContent("Image: d Image: p");
});
