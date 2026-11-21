import { useEffect, useState } from "react";
import { highlight, resolveLang } from "./highlight";

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  // The highlight remembers which language it was made for, so a language change never shows the old one's markup.
  const [stored, setStored] = useState<{ lang: string; html: string } | null>(null);
  const supported = resolveLang(lang) !== undefined;
  // Drop a highlight made for another language now, so it can't reappear if the language changes back.
  if (stored && stored.lang !== lang) setStored(null);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    // Same language: keep the previous highlight on screen until this one is ready, so edits don't flash to plain text.
    highlight(code, lang)
      .then((h) => live && setStored(h === null ? null : { lang, html: h }))
      .catch(() => live && setStored(null)); // failed chunk load: fall back to the plain block
    return () => {
      live = false;
    };
  }, [code, lang, supported]);
  if (supported && stored?.lang === lang)
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is generated from escaped code tokens, not user HTML.
    return <div dangerouslySetInnerHTML={{ __html: stored.html }} />;
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
