import { useState } from "react";
import { codeTextClass } from "@/components/code-text";

/** Bidi embeddings and isolates, zero-width and direction marks, tag characters, variation selectors, line and paragraph separators, Hangul fillers, soft hyphen, and C0/C1 controls other than tab and newline. */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    (code >= 0x2061 && code <= 0x2064) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    code === 0x00ad ||
    code === 0x180e ||
    (code >= 0x80 && code <= 0x9f) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x3164 ||
    code === 0x7f ||
    (code < 0x20 && code !== 0x09 && code !== 0x0a)
  );
}

/** Shows invisible, bidi and control characters as visible tokens, so text can't hide or reorder itself. */
export function visibleControls(s: string): string {
  let out = "";
  // CRLF is a line break, not a control character; a lone CR still shows as a token.
  for (const c of s.replace(/\r\n/g, "\n")) {
    const code = c.codePointAt(0) ?? 0;
    if (!isInvisible(code)) out += c;
    else out += code === 0x1b ? "⟨ESC⟩" : `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  }
  return out;
}

/** Third-party code or file text: mono, wrapped anywhere, bidi-isolated, never markdown or links. Past
 *  `clampLines` it shows the first lines (`fromTop`) or the last ones, with "Show all · N lines". */
export function UntrustedCode({
  text,
  clampLines = 40,
  fromTop = false,
}: {
  text: string;
  clampLines?: number;
  fromTop?: boolean;
}) {
  const [all, setAll] = useState(false);
  const lines = visibleControls(text).split("\n");
  const clamped = !all && lines.length > clampLines;
  const shown = clamped ? (fromTop ? lines.slice(0, clampLines) : lines.slice(-clampLines)) : lines;
  return (
    <div>
      <pre
        dir="ltr"
        className={`${codeTextClass} whitespace-pre-wrap [overflow-wrap:anywhere] [unicode-bidi:isolate]`}
      >
        {shown.join("\n")}
      </pre>
      {clamped ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Show all · {lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

/** Third-party prose (descriptions, commit subjects): Geist, direction from its own text, isolated. */
export function UntrustedProse({ text }: { text: string }) {
  return (
    <span dir="auto" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
      {visibleControls(text)}
    </span>
  );
}

/** Third-party code text inline (a program name, a source URL, a dependency): mono, left-to-right, isolated, wrapped
 *  anywhere, with invisible characters shown as tokens (spec §10.6). The inline form of `UntrustedCode`. */
export function UntrustedInlineCode({ text }: { text: string }) {
  return (
    <span
      dir="ltr"
      className={`${codeTextClass} whitespace-pre-wrap [overflow-wrap:anywhere] [unicode-bidi:isolate]`}
    >
      {visibleControls(text)}
    </span>
  );
}
