import { ArrowUpRight } from "lucide-react";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, PlainCode } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

/** The bit of a hast node the image rewrite reads (react-markdown's tree, without importing hast). */
type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

const IMAGE_ALT_MAX = 80;
const HTTP = /^https?:\/\//i;

/** "Image: <alt>", the alt cut to 80 characters, else the source's host (U3 §9.3). */
function imageLabel(alt: string, src: string): string {
  const a = alt.trim();
  if (a) return `Image: ${a.length > IMAGE_ALT_MAX ? `${a.slice(0, IMAGE_ALT_MAX - 1)}…` : a}`;
  try {
    return `Image: ${new URL(src).host}`;
  } catch {
    return "Image";
  }
}

/** Nothing loads from arbitrary hosts (U3 §9.3): every `img` becomes a link to its source reading
 *  "Image: <alt>", or plain text when it is already inside a link or its source isn't http(s).
 *  A rehype step, so the result goes through the same `a` renderer and URL sanitizing as any link. */
function imagesAsLinks() {
  const walk = (node: HastNode, inLink: boolean) => {
    const children = node.children;
    if (!children) return;
    for (const [i, child] of children.entries()) {
      if (child.type !== "element") continue;
      if (child.tagName === "img") {
        const src = typeof child.properties?.src === "string" ? child.properties.src : "";
        const alt = typeof child.properties?.alt === "string" ? child.properties.alt : "";
        const text: HastNode = { type: "text", value: imageLabel(alt, src) };
        children[i] =
          inLink || !HTTP.test(src)
            ? text
            : {
                type: "element",
                tagName: "a",
                properties: { href: src, ...(alt.trim() ? { title: alt } : {}) },
                children: [text],
              };
      } else walk(child, inLink || child.tagName === "a");
    }
  };
  return (tree: HastNode) => walk(tree, false);
}

function makeComponents(newTabNoteId: string, untrusted: boolean): Components {
  return {
    a: ({ href, title, children }) => {
      const external = typeof href === "string" && /^https?:\/\//.test(href);
      return external ? (
        // The accessible name stays the link text; "Opens in a new tab" is a shared description.
        <a
          href={href}
          title={title}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={newTabNoteId}
        >
          {children}
          <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3 align-[-0.1em]" />
        </a>
      ) : (
        <a href={href} title={title}>
          {children}
        </a>
      );
    },
    // Wide tables scroll inside their own box instead of widening the page.
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
    // Fenced blocks arrive as <pre><code>: `pre` owns block rendering, `code` stays inline-only.
    pre: ({ node }) => {
      const codeEl = node?.children[0];
      const props = codeEl && codeEl.type === "element" ? codeEl.properties : {};
      const classes = Array.isArray(props.className) ? props.className.map(String) : [];
      const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
      const text =
        codeEl && codeEl.type === "element"
          ? codeEl.children
              .map((c) => (c.type === "text" ? c.value : ""))
              .join("")
              .replace(/\n$/, "")
          : "";
      // Untrusted text (tool output) never drives the diagram renderer: its source shows as code.
      if (lang === "mermaid")
        return untrusted ? <PlainCode code={text} /> : <MermaidBlock source={text} />;
      // Every fence this renderer sees is closed (persisted text); the streaming tail renders its
      // open fence with `closed={false}` (U3 §10).
      if (lang) return <CodeBlock code={text} lang={lang} closed />;
      return <PlainCode code={text} />;
    },
    code: ({ className, children }) => <code className={className}>{children}</code>,
    // Bidi (U3 §7.2): each block takes the direction of its own first strong character.
    p: ({ children }) => <p dir="auto">{children}</p>,
    li: ({ className, children }) => (
      <li dir="auto" className={className}>
        {children}
      </li>
    ),
    blockquote: ({ children }) => <blockquote dir="auto">{children}</blockquote>,
    h1: ({ children }) => <h1 dir="auto">{children}</h1>,
    h2: ({ children }) => <h2 dir="auto">{children}</h2>,
    h3: ({ children }) => <h3 dir="auto">{children}</h3>,
    h4: ({ children }) => <h4 dir="auto">{children}</h4>,
    h5: ({ children }) => <h5 dir="auto">{children}</h5>,
    h6: ({ children }) => <h6 dir="auto">{children}</h6>,
  };
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [imagesAsLinks];
const VARIANT_CLASS = { default: "", detail: " prose-of-detail", work: " prose-of-work" } as const;

/** GFM markdown, no raw HTML (no rehype-raw), default URL sanitizing, no image ever loads (each is a
 *  link). Callers constrain the width. Memoized on its props: a parent re-render with the same props
 *  doesn't parse again. */
export const Markdown = memo(function Markdown({
  source,
  variant = "default",
  untrusted = false,
}: {
  source: string;
  /** "detail": a task body, comment or any speaker's markdown in a session; headings step down one
   *  size (a document never outranks its title). "work": tool output, 13/20 (U3 §7.3). */
  variant?: "default" | "detail" | "work";
  /** Text from outside (tool results, fetched pages, U3 §9.3): mermaid fences render as code. */
  untrusted?: boolean;
}) {
  const newTabNoteId = useId();
  const components = useMemo(
    () => makeComponents(newTabNoteId, untrusted),
    [newTabNoteId, untrusted],
  );
  return (
    <div className={`prose prose-sm prose-of max-w-none${VARIANT_CLASS[variant]}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
      <span id={newTabNoteId} hidden>
        Opens in a new tab
      </span>
    </div>
  );
});
