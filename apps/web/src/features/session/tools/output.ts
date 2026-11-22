/** Tool output is untrusted text from another program: these helpers only ever return text, which
 *  React renders as text (never HTML). */

/* biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching control characters is the point */
// CSI (colours, cursor moves), OSC (titles, hyperlinks; BEL- or ST-terminated) and the two-byte escapes.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// C0 except tab and newline, DEL and C1.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// A line redrawn with carriage returns (a progress bar): everything up to its last `\r` before text.
const REDRAWN = /[^\n]*\r(?=[^\n])/g;
/* biome-ignore-end lint/suspicious/noControlCharactersInRegex: matching control characters is the point */

/** ANSI escapes and control characters removed; tabs and newlines kept, CRLF read as a newline. */
export function stripAnsi(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(ANSI, "").replace(REDRAWN, "").replace(CONTROL, "");
}

/** More than 10% NUL, control (other than tab, newline, carriage return and ESC) or U+FFFD. */
export function isBinary(s: string): boolean {
  if (!s) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c === 0xfffd ||
      c === 0x7f ||
      (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 27) ||
      (c >= 0x80 && c <= 0x9f)
    )
      bad++;
  }
  return bad / s.length > 0.1;
}

/**
 * The end of an output: its last `lines` lines or `chars` characters, whichever is shorter, starting
 * at a line start when the character cut lands mid-line and an earlier newline exists. `total` is
 * the output's line count; `cut` whether anything was left out.
 */
export function tailOutput(
  text: string,
  lines = 12,
  chars = 2000,
): { tail: string; total: number; cut: boolean } {
  const body = text.replace(/\n+$/, "");
  if (!body) return { tail: "", total: 0, cut: false };
  let total = 1;
  let start = body.length;
  // Walk back to the start of the last `lines` lines without splitting the whole output.
  for (let seen = 0; start > 0; ) {
    const nl = body.lastIndexOf("\n", start - 1);
    if (nl === -1) {
      start = 0;
      break;
    }
    if (++seen === lines) {
      start = nl + 1;
      break;
    }
    start = nl;
  }
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) total++;
  let tail = body.slice(start);
  if (tail.length > chars) {
    tail = tail.slice(-chars);
    const nl = tail.indexOf("\n");
    if (nl !== -1 && nl < tail.length - 1) tail = tail.slice(nl + 1);
    else if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1); // never half a surrogate pair
  }
  return { tail, total, cut: tail.length < body.length };
}

/** The first non-empty line, without the CLI's `<tool_use_error>` wrapper: a failure's detail line. */
export function firstLine(s: string): string {
  for (const line of stripAnsi(s.replace(/<\/?tool_use_error>/g, "")).split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** UTF-8 size in bytes. */
export const byteSize = (s: string) => new TextEncoder().encode(s).length;
