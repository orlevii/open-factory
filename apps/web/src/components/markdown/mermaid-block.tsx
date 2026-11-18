import { CircleAlert } from "lucide-react";
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
        // "neutral" on a light paper card in both color schemes: mermaid bakes colors into the
        // SVG, so following the system theme would need JS theme switching (UI design §7.4).
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
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
        <p className="not-prose flex items-center gap-1.5 text-[0.8125rem] text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Couldn't render this diagram.
        </p>
        <p className="not-prose mt-1 line-clamp-2 font-mono text-xs text-muted-foreground">
          {error}
        </p>
        <pre className="mt-2">
          <code>{source}</code>
        </pre>
      </div>
    );
  // biome-ignore lint/security/noDangerouslySetInnerHtml: securityLevel "strict" makes mermaid sanitize its SVG output.
  if (svg) return <div className="md-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <pre>
      <code>{source}</code>
    </pre>
  );
}
