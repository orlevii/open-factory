import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import { MermaidBlock } from "./mermaid-block";

const components: Components = {
  a: ({ href, children }) => {
    const external = typeof href === "string" && /^https?:\/\//.test(href);
    return external ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href}>{children}</a>
    );
  },
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

/** GFM markdown, no raw HTML (no rehype-raw), default URL sanitizing. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
