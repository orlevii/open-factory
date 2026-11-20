/** Display names, descriptions, task titles and the like are user- or agent-controlled: one line, and no angle
 *  brackets, so they can't forge a `<factory-message>` envelope or start a heading/list line of their own.
 *  The one owner of this sanitiser (S7 §11.1, S8 §7.3). */
export function inline(text: string): string {
  return text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/** `inline`, then the text in double quotes with its own `"` made `'` (so it can't close the quotes). */
export function quoted(text: string): string {
  return `"${inline(text).replace(/"/g, "'")}"`;
}
