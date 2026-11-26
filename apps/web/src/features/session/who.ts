import { scanTags } from "@open-factory/shared/tags";

const LABEL = /\|([^>]+)>$/;

/** A principal as the factory writes it in an envelope or a tool result: `<@ref|handle>` (the label as it was
 *  when the text was written; the ref is what counts). Anything else is a plain `@handle`, a bare handle or a word. */
export type Who = { ref: string; handle: string | undefined };

export function parseWho(text: string): Who | undefined {
  const [t] = scanTags(text.trim()).tokens;
  if (!t || t.start !== 0 || t.end !== text.trim().length) return undefined;
  return { ref: t.ref, handle: LABEL.exec(text.trim())?.[1] };
}

/** The principal's ref when `text` is a tag. */
export const refOfWho = (text: string): string | undefined => parseWho(text)?.ref;

/** `@handle` for display: a tag shows its label, `@x` and `#x` stay, a bare handle gets its `@`. */
export function whoName(text: string): string {
  const w = parseWho(text);
  if (w) return `@${w.handle ?? w.ref}`;
  return /^[@#]/.test(text) ? text : `@${text}`;
}

/** The bare handle (no `@`) of a tag's label or a plain handle. */
export const whoHandle = (text: string): string => whoName(text).replace(/^@/, "");

/** Two writings of the same principal: the same ref, else the same name. */
export const sameWho = (a: string, b: string): boolean => {
  const ra = refOfWho(a);
  const rb = refOfWho(b);
  return ra !== undefined && rb !== undefined ? ra === rb : whoName(a) === whoName(b);
};
