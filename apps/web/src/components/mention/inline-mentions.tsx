import { scanMentions } from "@open-factory/shared/mentions";
import { Fragment, useMemo } from "react";
import { Mention } from "./mention";

/** Text with each `<@ref>` as a chip, for a heading that isn't markdown. */
export function InlineMentions({
  text,
  interactive = true,
}: {
  text: string;
  interactive?: boolean;
}) {
  const parts = useMemo(() => {
    const out: { key: number; text?: string; ref?: string }[] = [];
    let at = 0;
    for (const t of scanMentions(text).tokens) {
      if (t.start > at) out.push({ key: at, text: text.slice(at, t.start) });
      out.push({ key: t.start, ref: t.ref });
      at = t.end;
    }
    if (at < text.length) out.push({ key: at, text: text.slice(at) });
    return out;
  }, [text]);
  return parts.map((p) =>
    p.ref ? (
      <Mention key={p.key} principalRef={p.ref} interactive={interactive} />
    ) : (
      <Fragment key={p.key}>{p.text}</Fragment>
    ),
  );
}
