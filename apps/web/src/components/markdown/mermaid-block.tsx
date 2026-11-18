import { useEffect, useId, useState } from "react";

/** First line of the error, capped, so a parser dump doesn't flood the note. */
function shortError(e: unknown): string {
  const first = (e instanceof Error ? e.message : "").split("\n")[0]?.trim() ?? "";
  if (!first) return "Invalid diagram";
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

export function MermaidBlock({ source }: { source: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // New source: drop the previous diagram or error until this one resolves.
    setSvg(null);
    setError(null);
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const out = await mermaid.render(id, source);
        if (live) setSvg(out.svg);
      } catch (e) {
        // Covers both a failed chunk load and an invalid diagram.
        if (live) setError(shortError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [id, source]);
  if (error)
    return (
      <div>
        <p className="text-destructive text-sm">Diagram error: {error}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  // biome-ignore lint/security/noDangerouslySetInnerHtml: securityLevel "strict" makes mermaid sanitize its SVG output.
  if (svg) return <div dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <pre>
      <code>{source}</code>
    </pre>
  );
}
