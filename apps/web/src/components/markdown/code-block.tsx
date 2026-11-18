import { useEffect, useState } from "react";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // New code or language: never keep showing the previous highlight.
    setHtml(null);
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" } }),
      )
      .then((h) => live && setHtml(h))
      .catch(() => {}); // unknown language or failed chunk load: keep the plain block
    return () => {
      live = false;
    };
  }, [code, lang]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is generated from escaped code tokens, not user HTML.
  if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
