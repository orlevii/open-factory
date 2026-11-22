import { ArrowUpRight } from "lucide-react";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

function makeComponents(newTabNoteId: string): Components {
  return {
    a: ({ href, children }) => {
      const external = typeof href === "string" && /^https?:\/\//.test(href);
      return external ? (
        // The accessible name stays the link text; "Opens in a new tab" is a shared description.
        <a href={href} target="_blank" rel="noopener noreferrer" aria-describedby={newTabNoteId}>
          {children}
          <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3 align-[-0.1em]" />
        </a>
      ) : (
        <a href={href}>{children}</a>
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
      if (lang === "mermaid") return <MermaidBlock source={text} />;
      if (lang) return <CodeBlock code={text} lang={lang} />;
      return (
        <pre>
          <code>{text}</code>
        </pre>
      );
    },
    code: ({ className, children }) => <code className={className}>{children}</code>,
  };
}

const REMARK_PLUGINS = [remarkGfm];
const VARIANT_CLASS = { default: "", detail: " prose-of-detail", work: " prose-of-work" } as const;

/** GFM markdown, no raw HTML (no rehype-raw), default URL sanitizing. Callers constrain the width.
 *  Memoized on `source` and `variant`: a parent re-render with the same props doesn't parse again. */
export const Markdown = memo(function Markdown({
  source,
  variant = "default",
}: {
  source: string;
  /** "detail": a task body, comment or any speaker's markdown in a session; headings step down one
   *  size (a document never outranks its title). "work": tool output, 13/20 (U3 §7.3). */
  variant?: "default" | "detail" | "work";
}) {
  const newTabNoteId = useId();
  const components = useMemo(() => makeComponents(newTabNoteId), [newTabNoteId]);
  return (
    <div className={`prose prose-sm prose-of max-w-none${VARIANT_CLASS[variant]}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {source}
      </ReactMarkdown>
      <span id={newTabNoteId} hidden>
        Opens in a new tab
      </span>
    </div>
  );
});
