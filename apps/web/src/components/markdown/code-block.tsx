import { type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-feedback";
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
    return (
      <CopyFrame code={code}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is generated from escaped code tokens, not user HTML. */}
        <div dangerouslySetInnerHTML={{ __html: stored.html }} />
      </CopyFrame>
    );
  return <PlainCode code={code} />;
}

/** A fenced block with no language: the plain `pre`, with the same Copy button. */
export function PlainCode({ code }: { code: string }) {
  return (
    <CopyFrame code={code}>
      <pre>
        <code>{code}</code>
      </pre>
    </CopyFrame>
  );
}

/** Code with a Copy button at its top-right, on hover or focus within (U3 §7.5). */
function CopyFrame({ code, children }: { code: string; children: ReactNode }) {
  return (
    // The wrapper is the prose's child now, so typography's first/last-child margin reset is passed
    // on to the pre inside it.
    <div className="group/code relative first:[&_pre]:mt-0 last:[&_pre]:mb-0">
      {children}
      <CopyButton text={code} />
    </div>
  );
}
