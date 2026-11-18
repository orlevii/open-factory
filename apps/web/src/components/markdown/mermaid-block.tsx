import { useEffect, useId, useState } from "react";

export function MermaidBlock({ source }: { source: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      try {
        const out = await mermaid.render(id, source);
        if (live) setSvg(out.svg);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Invalid diagram");
      }
    });
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
