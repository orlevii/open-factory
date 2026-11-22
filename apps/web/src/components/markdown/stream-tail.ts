/**
 * The streaming tail (U3 §11.4): the open (last) block of live agent text, prepared so it never shows
 * raw markdown syntax that the next characters would turn into something else. Pure and in-house
 * (Q35): an open fence becomes plain code in frozen slices, unclosed inline marks are closed, and a
 * trailing line that is only a marker (or a table header before its delimiter row) is held back.
 */
import { type Fence, stepFence } from "./split-blocks";

export type PreparedTail =
  | { kind: "markdown"; source: string }
  /** An open fence: plain code (never parsed), its lines in frozen 50-line slices so growth appends
   *  nodes; `lead` is the block's markdown before the fence. */
  | { kind: "fence"; lead?: string; lang?: string; slices: string[] };

const SLICE_LINES = 50;

/** A trailing line held until its newline: only `-`, `=`, `*` or `_`; a bare list, heading, quote or
 *  number marker; or one starting with a backtick or tilde (a fence opener, or code not yet closed). */
const HELD_LINE = [
  /^\s*([-=*_])(?:\s*\1)*\s*$/,
  /^\s*(?:[-*+]|\d{1,9}[.)])\s*$/,
  /^\s{0,3}#{1,6}\s*$/,
  /^\s*>\s*$/,
  /^\s{0,3}[`~]/,
];
/** What a table delimiter row looks like while it is still arriving. */
const DELIMITER_PREFIX = /^[\s|:-]*$/;
/** A line that starts a new inline context: a list item, a quote, a heading or a table row. */
const BLOCK_START = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|>|#{1,6}\s|\|)/;
const BLANK = /^\s*$/;
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;
/** A link or image whose destination hasn't closed: shown as its text. */
const HALF_LINK = /!?\[([^\]\n]*)\]\([^)\s]*$/;
const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const TRAILING_SPACE = /\s+$/;

export function prepareTail(tail: string): PreparedTail {
  // The line hold comes first: a fence opener or closer counts only once its newline arrives.
  const text = holdLine(tail);
  const lines = text.split("\n");
  let fence: Fence | undefined;
  let openAt = -1;
  for (const [i, line] of lines.entries()) {
    const was = fence;
    fence = stepFence(line, fence);
    if (!was && fence) openAt = i;
  }
  if (fence) {
    const opener = lines[openAt] as string;
    const indent = opener.length - opener.trimStart().length;
    let code = lines.slice(openAt + 1);
    // The last line may be a closer in progress.
    const last = code.at(-1) ?? "";
    if (
      last !== "" &&
      last
        .trim()
        .split("")
        .every((c) => c === fence.char)
    )
      code = code.slice(0, -1);
    // A newline with nothing after it yet adds no line.
    if (code.at(-1) === "") code = code.slice(0, -1);
    if (indent > 0) {
      // Inside a list item: keep the item, with the fence closed virtually and no language, so it
      // renders as plain code until the real closer arrives.
      const marker = fence.char.repeat(fence.len);
      const pad = opener.slice(0, indent);
      return {
        kind: "markdown",
        source: [...lines.slice(0, openAt), pad + marker, ...code, pad + marker].join("\n"),
      };
    }
    const lang = opener.trim().slice(fence.len).trim().split(/\s/, 1)[0];
    const slices: string[] = [];
    for (let i = 0; i < code.length; i += SLICE_LINES) {
      const chunk = code.slice(i, i + SLICE_LINES).join("\n");
      slices.push(i + SLICE_LINES < code.length ? `${chunk}\n` : chunk);
    }
    return {
      kind: "fence",
      ...(openAt > 0 ? { lead: lines.slice(0, openAt).join("\n") } : {}),
      ...(lang ? { lang } : {}),
      slices,
    };
  }
  return { kind: "markdown", source: closeInline(holdTable(text)) };
}

/** Drops a trailing (newline-less) line that is only a marker. */
function holdLine(text: string): string {
  const cut = text.lastIndexOf("\n") + 1;
  const last = text.slice(cut);
  return last !== "" && HELD_LINE.some((r) => r.test(last)) ? text.slice(0, cut) : text;
}

/** Drops a trailing table header (and a delimiter row still arriving) until the delimiter row is
 *  complete; a pipe line that can no longer start a table shows. */
function holdTable(text: string): string {
  const lines = text.split("\n");
  let end = lines.length - 1;
  if (lines[end] === "") end--;
  if (end < 0 || !lines[end]?.includes("|")) return text;
  let start = end;
  while (start > 0 && lines[start - 1]?.includes("|")) start--;
  const run = end - start + 1;
  // The delimiter row counts once its newline arrives; until then it is only a prefix.
  const delimiterPending = run === 2 && end === lines.length - 1;
  const hold = run === 1 || (delimiterPending && DELIMITER_PREFIX.test(lines[end] as string));
  if (!hold) return text;
  return start === 0 ? "" : `${lines.slice(0, start).join("\n")}\n`;
}

/** The start of the last inline context: after the last blank line or fence line, or at the last
 *  line that starts a list item, quote, heading or table row. */
function segmentStart(text: string): number {
  const lines = text.split("\n");
  let at = text.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    at -= line.length;
    if (BLOCK_START.test(line)) return at;
    if (FENCE_LINE.test(line)) return at + line.length + 1;
    if (i < lines.length - 1 && BLANK.test(line)) return at + line.length + 1;
    at -= 1; // the newline before it
  }
  return 0;
}

const isSpace = (c: string | undefined) => c === undefined || WHITESPACE.test(c);
const isPunct = (c: string | undefined) => c !== undefined && PUNCTUATION.test(c);

/** Closes an open code span and open `*`/`_` emphasis in the last inline context, shows a half link
 *  as its text, and holds a trailing `*`/`_` run that closes nothing. `_` follows GFM's flanking
 *  rules, so `foo_bar` is never emphasis. */
function closeInline(text: string): string {
  const from = segmentStart(text);
  const head = text.slice(0, from);
  const seg = text.slice(from).replace(HALF_LINK, "$1");
  const stack: { ch: string; len: number }[] = [];
  let code = 0; // the open code span's backtick count
  let held = -1;
  let i = 0;
  while (i < seg.length) {
    const c = seg[i] as string;
    if (c === "\\" && code === 0) {
      i += 2;
      continue;
    }
    if (c === "`" || ((c === "*" || c === "_") && code === 0)) {
      let n = 1;
      while (seg[i + n] === c) n++;
      if (c === "`") {
        if (code === 0) code = n;
        else if (n === code) code = 0;
        i += n;
        continue;
      }
      // At the end the next character is unknown: treated as whitespace.
      const prev = seg[i - 1];
      const next = seg[i + n];
      const left = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev));
      const right = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next));
      const canOpen = c === "*" ? left : left && (!right || isPunct(prev));
      const canClose = c === "*" ? right : right && (!left || isPunct(next));
      const open = canClose ? stack.findLastIndex((d) => d.ch === c) : -1;
      if (open >= 0) stack.length = open;
      else if (canOpen) stack.push({ ch: c, len: n });
      else if (i + n === seg.length) held = i;
      i += n;
      continue;
    }
    i++;
  }
  let out = held >= 0 ? seg.slice(0, held) : seg;
  if (code > 0) out += "`".repeat(code);
  else if (stack.length > 0)
    out =
      out.replace(TRAILING_SPACE, "") +
      stack
        .reverse()
        .map((d) => d.ch.repeat(d.len))
        .join("");
  return head + out;
}
