import { useEffect, useState } from "react";
import { highlight, resolveLang } from "./highlight";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const supported = resolveLang(lang) !== undefined;
  // An unhighlighted language drops the old highlight now, so it can't reappear if the language changes back.
  if (!supported && html !== null) setHtml(null);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    // Keep the previous highlight on screen until this one is ready, so edits don't flash to plain text.
    highlight(code, lang)
      .then((h) => live && setHtml(h))
      .catch(() => live && setHtml(null)); // failed chunk load: fall back to the plain block
    return () => {
      live = false;
    };
  }, [code, lang, supported]);
  if (supported && html)
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is generated from escaped code tokens, not user HTML.
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
