import { normaliseRef } from "@open-factory/shared";
import { scanTags, tagOf } from "@open-factory/shared/tags";
import { BLOCKS } from "@/components/tag/copy-tags";

/** One tag in the text: `[start, end)` covers its `@handle`, `ref` is the principal it stands for. */
export type TagRange = { start: number; end: number; ref: string };
export type Tagged = { text: string; ranges: readonly TagRange[] };

const byStart = (a: TagRange, b: TagRange) => a.start - b.start;

/** Replaces `[from, to)` with `insert`. A range the edit lands in is dropped; one after it shifts by the length delta. */
function splice(t: Tagged, from: number, to: number, insert: string): Tagged {
  const delta = insert.length - (to - from);
  const ranges = t.ranges.flatMap((r): TagRange[] => {
    if (r.end <= from) return [r];
    if (r.start >= to) return [{ ...r, start: r.start + delta, end: r.end + delta }];
    return [];
  });
  return { text: t.text.slice(0, from) + insert + t.text.slice(to), ranges };
}

/** The stored text with each `<@ref>` / `<@ref|label>` (outside code) shown as `@handle` and ranged. */
export function hydrate(stored: string, handleOf: (ref: string) => string): Tagged {
  let text = "";
  let last = 0;
  const ranges: TagRange[] = [];
  for (const tok of scanTags(stored).tokens) {
    text += stored.slice(last, tok.start);
    const label = `@${handleOf(tok.ref)}`;
    ranges.push({ start: text.length, end: text.length + label.length, ref: tok.ref });
    text += label;
    last = tok.end;
  }
  return { text: text + stored.slice(last), ranges };
}

/** The text with each range written as its `<@ref>`. */
export function serialise(t: Tagged): string {
  let out = "";
  let last = 0;
  for (const r of [...t.ranges].sort(byStart)) {
    out += t.text.slice(last, r.start) + tagOf(r.ref);
    last = r.end;
  }
  return out + t.text.slice(last);
}

/**
 * The text after an edit, with the ranges that survive it. The edit is the span between the common prefix and
 * suffix of the two texts, so an insertion at a range's start shifts it and one at its end leaves it alone.
 * The common prefix is greedy, so an edit that repeats a range's first character (typing `@` before `@ada`) would
 * read as an edit inside the range. Given `caret`, the selection end after the edit, the edit instead ends there:
 * the suffix is what follows the caret, clamped to what really matches, and the prefix takes what is left.
 */
export function rebase(prev: Tagged, nextText: string, caret?: number): Tagged {
  const a = prev.text;
  const b = nextText;
  const max = Math.min(a.length, b.length);
  let s = 0;
  if (caret === undefined) {
    let p = 0;
    while (p < max && a[p] === b[p]) p++;
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return splice(prev, p, a.length - s, b.slice(p, b.length - s));
  }
  let common = 0;
  while (common < max && a[a.length - 1 - common] === b[b.length - 1 - common]) common++;
  s = Math.min(Math.max(b.length - caret, 0), common);
  let p = 0;
  while (p < max - s && a[p] === b[p]) p++;
  return splice(prev, p, a.length - s, b.slice(p, b.length - s));
}

/**
 * Replaces `[from, to)` with a fragment (typed or pasted text with its own tags): the existing ranges keep or
 * shift as `splice` decides, the fragment's ranges land offset by `from`, and the caret goes after the fragment.
 */
export function insertTagged(
  t: Tagged,
  from: number,
  to: number,
  fragment: Tagged,
): { tagged: Tagged; caret: number } {
  const edited = splice(t, from, to, fragment.text);
  const landed = fragment.ranges.map((r) => ({ ...r, start: r.start + from, end: r.end + from }));
  return {
    tagged: { text: edited.text, ranges: [...edited.ranges, ...landed].sort(byStart) },
    caret: from + fragment.text.length,
  };
}

/** Replaces the typed `@query` at `[from, to)` with `@handle ` and ranges the new tag; the caret goes after the space. */
export function insertTag(
  t: Tagged,
  from: number,
  to: number,
  ref: string,
  handle: string,
): { tagged: Tagged; caret: number } {
  const label = `@${handle}`;
  const fragment: Tagged = { text: `${label} `, ranges: [{ start: 0, end: label.length, ref }] };
  return insertTagged(t, from, to, fragment);
}

/**
 * Where a collapsed caret lands, given its position after the native move. Only a caret strictly inside a range
 * snaps: `left` goes to the range's start, `right` to its end, and a click to the nearer edge (a tie goes to the
 * end). A caret on an edge never snaps. So ← from right after a tag moves natively to `end - 1`, which is inside,
 * and snaps to the start.
 */
export function snapCaret(
  ranges: readonly TagRange[],
  at: number,
  how: "click" | "left" | "right",
): number {
  for (const r of ranges) {
    if (!(r.start < at && at < r.end)) continue;
    if (how === "left") return r.start;
    if (how === "right") return r.end;
    return at - r.start < r.end - at ? r.start : r.end;
  }
  return at;
}

/** A selection edge strictly inside a range moves outward to that range's edge, so a selection holds whole tags. */
export function snapSelection(
  ranges: readonly TagRange[],
  start: number,
  end: number,
): [number, number] {
  const around = (x: number) => ranges.find((r) => r.start < x && x < r.end);
  const from = around(start);
  const to = around(end);
  return [from ? from.start : start, to ? to.end : end];
}

/**
 * Backspace at a tag's end, or Delete at its start, removes the tag and one following space. Anything else
 * (another caret, or the other key) is `undefined`, so the browser handles it.
 */
export function deleteTagAt(
  t: Tagged,
  caret: number,
  key: "Backspace" | "Delete",
): { tagged: Tagged; caret: number } | undefined {
  const r = t.ranges.find((x) => (key === "Backspace" ? x.end === caret : x.start === caret));
  if (!r) return undefined;
  const to = t.text[r.end] === " " ? r.end + 1 : r.end;
  return { tagged: splice(t, r.start, to, ""), caret: r.start };
}

/** The chips in a clipboard HTML fragment, with the text around them. Undefined when it holds no chip. */
function fromChipHtml(html: string, handleOf: (ref: string) => string): Tagged | undefined {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (!body.querySelector("[data-of-tag]")) return undefined;
  let text = "";
  const ranges: TagRange[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    const ref = normaliseRef(node.getAttribute("data-of-tag") ?? "");
    if (ref) {
      const label = `@${handleOf(ref)}`;
      ranges.push({ start: text.length, end: text.length + label.length, ref });
      text += label;
      return;
    }
    if (node.nodeName === "BR") {
      text += "\n";
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
    if (BLOCKS.has(node.nodeName)) text += "\n";
  };
  for (const child of Array.from(body.childNodes)) walk(child);
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return { text, ranges };
}

/** Pasted content as tags: the chip spans in its HTML if it has any, else the `<@ref>` tags in its plain text. */
export function fromClipboard(
  data: { html?: string; text: string },
  handleOf: (ref: string) => string,
): Tagged {
  const chips = data.html === undefined ? undefined : fromChipHtml(data.html, handleOf);
  return chips ?? hydrate(data.text, handleOf);
}

/**
 * The text in `[start, end)` as plain text, and as HTML with each whole tag in it as a `data-of-tag` span. Callers
 * snap the selection first (`snapSelection`); a tag the selection only partly covers is written as plain text.
 */
export function toClipboard(t: Tagged, start: number, end: number): { text: string; html: string } {
  let html = "";
  let at = start;
  for (const r of [...t.ranges].sort(byStart)) {
    if (r.start < at || r.end > end) continue;
    html += escapeHtml(t.text.slice(at, r.start));
    html += `<span data-of-tag="${r.ref}">${escapeHtml(t.text.slice(r.start, r.end))}</span>`;
    at = r.end;
  }
  html += escapeHtml(t.text.slice(at, end));
  return { text: t.text.slice(start, end), html };
}

const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
