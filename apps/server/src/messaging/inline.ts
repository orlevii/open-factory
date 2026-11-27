import { MENTION_SHAPE } from "@open-factory/shared/mentions";

/** Display names, descriptions, task titles and the like are user- or agent-controlled: one line, and no angle
 *  brackets (bar the exact `<@ref>` / `<@ref|handle>` mentions), so they can't forge a `<factory-message>` envelope or start a heading/list line of their own.
 *  The one owner of this sanitiser (S7 §11.1, S8 §7.3). */
export function inline(text: string): string {
  let out = "";
  let at = 0;
  // The two exact mention shapes pass; every other angle bracket goes.
  for (const m of text.matchAll(MENTION_SHAPE)) {
    out += text.slice(at, m.index).replace(/[<>]/g, "") + m[0];
    at = m.index + m[0].length;
  }
  return (out + text.slice(at).replace(/[<>]/g, "")).replace(/\s+/g, " ").trim();
}

/** `inline`, then the text in double quotes with its own `"` made `'` (so it can't close the quotes). */
export function quoted(text: string): string {
  return `"${inline(text).replace(/"/g, "'")}"`;
}
