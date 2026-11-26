import { scanTags } from "@open-factory/shared/tags";
import { Fragment, useMemo } from "react";
import { Tag } from "./tag";

/** Text with each `<@ref>` as a chip, for a heading that isn't markdown. */
export function InlineTags({ text, interactive = true }: { text: string; interactive?: boolean }) {
  const parts = useMemo(() => {
    const out: { key: number; text?: string; ref?: string }[] = [];
    let at = 0;
    for (const t of scanTags(text).tokens) {
      if (t.start > at) out.push({ key: at, text: text.slice(at, t.start) });
      out.push({ key: t.start, ref: t.ref });
      at = t.end;
    }
    if (at < text.length) out.push({ key: at, text: text.slice(at) });
    return out;
  }, [text]);
  return parts.map((p) =>
    p.ref ? (
      <Tag key={p.key} tagRef={p.ref} interactive={interactive} />
    ) : (
      <Fragment key={p.key}>{p.text}</Fragment>
    ),
  );
}
