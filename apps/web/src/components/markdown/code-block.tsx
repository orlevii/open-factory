import { type ReactNode, useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-feedback";
import { highlight, resolveLang } from "./highlight";
import { highlightCache } from "./highlight-cache";

/** A fenced block, highlighted once its fence is closed (U3 §10): an open fence (the streaming
 *  tail's last block) renders plain `<pre><code>` and never calls `highlight` until it closes.
 *  Persisted text is always closed. A highlight made before (`highlightCache`) paints on the first
 *  render, and the highlight effect runs only on a miss (U3 §11.4). */
export function CodeBlock({
  code,
  lang,
  closed = true,
}: {
  code: string;
  lang: string;
  closed?: boolean;
}) {
  const supported = resolveLang(lang) !== undefined;
  const cached = closed && supported ? highlightCache.get(lang, code) : undefined;
  // The highlight remembers which language it was made for, so a language change never shows the old one's markup.
  const [stored, setStored] = useState<{ lang: string; html: string } | null>(() =>
    cached === undefined ? null : { lang, html: cached },
  );
  // Drop a highlight made for another language now, so it can't reappear if the language changes back.
  if (stored && stored.lang !== lang) setStored(null);
  useEffect(() => {
    if (!supported || !closed || highlightCache.get(lang, code) !== undefined) return;
    let live = true;
    // Same language: keep the previous highlight on screen until this one is ready, so edits don't flash to plain text.
    highlight(code, lang)
      .then((h) => {
        if (h !== null) highlightCache.set(lang, code, h);
        if (live) setStored(h === null ? null : { lang, html: h });
      })
      .catch(() => live && setStored(null)); // failed chunk load: fall back to the plain block
    return () => {
      live = false;
    };
  }, [code, lang, supported, closed]);
  const html = cached ?? (stored?.lang === lang ? stored.html : undefined);
  if (closed && supported && html !== undefined)
    return (
      <CopyFrame code={code}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is generated from escaped code tokens, not user HTML. */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </CopyFrame>
    );
  return <PlainCode code={code} />;
}

/** An open fence while it streams (U3 §11.4): the same plain `<pre><code>` as `PlainCode`, its text
 *  in frozen slices so growth appends text nodes instead of rewriting one. */
export function OpenFenceCode({ slices }: { slices: readonly string[] }) {
  return (
    <CopyFrame code={slices.join("")}>
      <pre>
        <code>{slices}</code>
      </pre>
    </CopyFrame>
  );
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
