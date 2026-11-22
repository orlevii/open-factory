/** Markdown split into top-level blocks, for clamping (U3 §7.6) and per-block rendering (§11.4). */

/** A fence opener or closer: up to any indent (a fence inside a list item), three or more ` or ~. */
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const QUOTE = /^>/;
const BLANK = /^\s*$/;
const COLUMN_ZERO = /^\S/;

export type Fence = { char: string; len: number };

/** The fence state after `line`: opened, closed (undefined) or unchanged. */
export function stepFence(line: string, open: Fence | undefined): Fence | undefined {
  const m = FENCE.exec(line);
  if (!m) return open;
  const marker = m[1] as string;
  const char = marker[0] as string;
  if (!open) return { char, len: marker.length };
  // A closer is the same character, at least as long, with nothing after it.
  return char === open.char && marker.length >= open.len && BLANK.test(line.slice(m[0].length))
    ? undefined
    : open;
}

/** Whether `next` (a column-0 line after a blank) carries on the block that starts with `first`:
 *  another item of a loose list, or more of a quote. */
const continues = (first: string, next: string) =>
  (LIST_ITEM.test(first) && LIST_ITEM.test(next)) || (QUOTE.test(first) && QUOTE.test(next));

/**
 * Splits at a blank line outside a fence when the next non-blank line starts at column 0 and doesn't
 * continue a list or quote, so loose lists and indented continuations stay one block. Blank lines
 * between blocks are dropped. `openFence`: the text ends inside a fence (a streaming tail, or a cut).
 * `starts`: each block's offset in `text`.
 */
export function splitBlocks(text: string): {
  blocks: string[];
  starts: number[];
  openFence: boolean;
} {
  const lines = text.split("\n");
  const blocks: string[] = [];
  const starts: number[] = [];
  let block: string[] = [];
  let fence: Fence | undefined;
  let blank = false; // a blank line outside a fence since the block's last line
  let at = 0; // the current line's offset
  for (const line of lines) {
    const lineAt = at;
    at += line.length + 1;
    if (!fence && BLANK.test(line)) {
      if (block.length > 0) blank = true;
      continue;
    }
    if (blank && !fence && COLUMN_ZERO.test(line) && !continues(block[0] as string, line)) {
      blocks.push(block.join("\n"));
      block = [];
    } else if (blank) block.push("");
    blank = false;
    if (block.length === 0) starts.push(lineAt);
    block.push(line);
    fence = stepFence(line, fence);
  }
  if (block.length > 0) {
    // Inside an open fence trailing blank lines belong to it, but nothing is lost by trimming them.
    while (block.length > 1 && BLANK.test(block.at(-1) as string)) block.pop();
    blocks.push(block.join("\n"));
  }
  return { blocks, starts, openFence: fence !== undefined };
}

// Syntax that doesn't render as characters: fence lines, heading/quote/list markers, images and links
// down to their text, emphasis and code marks, table pipes and rules, HTML tags.
const STRIP_FENCE_LINE = /^\s*(?:`{3,}|~{3,}).*$/gm;
const STRIP_LINE_MARKERS = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)+/gm;
const STRIP_IMAGE_OR_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const STRIP_MARKS = /[*_~`|]+/g;
// After the pipes are gone: a table's delimiter row (or a thematic break) is only dashes and colons.
const STRIP_TABLE_RULE = /^[\s:-]*-{3,}[\s:-]*$/gm;
const STRIP_TAGS = /<\/?[a-zA-Z][^>]*>/g;
const NEWLINES = /\n/g;

/** The rendered character count of `md`, roughly: its source with markdown syntax stripped by a cheap
 *  regex pass, newlines not counted (U3 §7.6). */
export function plainLength(md: string): number {
  return md
    .replace(STRIP_FENCE_LINE, "")
    .replace(STRIP_LINE_MARKERS, "")
    .replace(STRIP_IMAGE_OR_LINK, "$1")
    .replace(STRIP_TAGS, "")
    .replace(STRIP_MARKS, "")
    .replace(STRIP_TABLE_RULE, "")
    .replace(NEWLINES, "").length;
}

/** `text` with a fence it leaves open closed, so a cut never renders the rest as code. */
function closeFence(text: string): string {
  let fence: Fence | undefined;
  for (const line of text.split("\n")) fence = stepFence(line, fence);
  return fence ? `${text}\n${fence.char.repeat(fence.len)}` : text;
}

const lineCount = (s: string) => s.split("\n").length;

/** The most code lines any one fenced block holds (an unclosed fence counts to the end). */
export function longestFence(md: string): number {
  let fence: Fence | undefined;
  let longest = 0;
  let n = 0;
  for (const line of md.split("\n")) {
    const next = stepFence(line, fence);
    if (fence && next) n++;
    else if (fence && !next) longest = Math.max(longest, n);
    if (!fence && next) n = 0;
    fence = next;
  }
  return fence ? Math.max(longest, n) : longest;
}

/** A first block too big on its own: cut by lines, then by characters, its fence closed virtually. */
function cutBlock(block: string, maxLines: number, maxChars: number): string {
  // One line is kept back for a virtual fence closer.
  const lines = block.split("\n").slice(0, maxLines - 1);
  while (lines.length > 1 && plainLength(lines.join("\n")) > maxChars) lines.pop();
  let out = lines.join("\n");
  // One line still over: a raw cut renders no more characters than it has.
  if (plainLength(out) > maxChars) out = out.slice(0, maxChars);
  return closeFence(out);
}

/**
 * The source to show while clamped: the blocks up to the last block boundary before 40 lines or
 * 4,000 rendered characters (whichever comes first), a fence left open closed virtually.
 * `undefined` when the whole body is within both limits (U3 §7.6).
 */
export function clampSource(md: string, maxLines = 40, maxChars = 4000): string | undefined {
  if (lineCount(md) <= maxLines && plainLength(md) <= maxChars) return undefined;
  const { blocks } = splitBlocks(md);
  let lines = 0;
  let chars = 0;
  let take = 0;
  for (const b of blocks) {
    // A block after the first adds its blank separator line.
    const l = lineCount(b) + (take > 0 ? 1 : 0);
    const c = plainLength(b);
    if (lines + l > maxLines || chars + c > maxChars) break;
    lines += l;
    chars += c;
    take++;
  }
  if (take === 0) return cutBlock(blocks[0] ?? "", maxLines, maxChars);
  // Only blank lines were over: every block fits, so there is nothing to hide.
  if (take === blocks.length) return undefined;
  return closeFence(blocks.slice(0, take).join("\n\n"));
}
