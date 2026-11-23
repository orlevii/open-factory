// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
// Spec §11.3. Pure helpers for the recording script: redact a raw `claude setup-token` transcript, then write it. Nothing
// here logs; the transcript holds the sign-in URL, the code and a real token until redaction has run.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** What can sit between two characters of a wrapped value: a line break, indentation, a cursor move or an OSC. */
const NOISE_SRC =
  "(?:\\x1b\\][^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)|\\x1b\\[[0-?]*[ -/]*[@-~]|[ \\r\\n])";
const NOISE_STICKY = new RegExp(NOISE_SRC, "y");
const NOISE_ALL = new RegExp(NOISE_SRC, "g");
/** The text with every terminal code, line break and space removed, so a value split by a wrap reads whole. */
const stripNoise = (s: string) => s.replace(NOISE_ALL, "");
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * Replaces every occurrence of `secret` (also when wrapped or split by terminal codes) with `replacement`, character
 * for character, and leaves the interleaved codes as they were. An OSC inside a match is redacted too, not copied:
 * wrap-ansi re-opens an OSC 8 hyperlink on every wrapped line, so the display text's match swallows full copies of
 * the URI. Both strings must be the same length and `secret` must contain no ESC, BEL, CR, LF or space.
 */
function replaceWrapped(raw: string, secret: string, replacement: string): string {
  if (secret.length === 0) return raw;
  const re = new RegExp([...secret].map(escapeRe).join(`${NOISE_SRC}*`), "g");
  return raw.replace(re, (match) => {
    let out = "";
    let k = 0;
    for (let i = 0; i < match.length; ) {
      const c = match[i] as string;
      if (c === "\x1b" || c === "\r" || c === "\n" || c === " ") {
        NOISE_STICKY.lastIndex = i;
        const n = NOISE_STICKY.exec(match);
        const len = n ? n[0].length : 1;
        const noise = match.slice(i, i + len);
        out += noise.startsWith("\x1b]") ? replaceWrapped(noise, secret, replacement) : noise;
        i += len;
      } else {
        out += replacement[k++];
        i++;
      }
    }
    return out;
  });
}

// Public protocol constants. Redacting them would only stop the output from parsing as a sign-in prompt.
const KEEP = new Set(["redirect_uri", "response_type", "code_challenge_method"]);

/** Shorter values (`code=true`) are not secrets and would match ordinary text. */
const MIN_SECRET = 8;

/** The URL's query values, minus the public constants. */
function urlValues(url: string): string[] {
  const q = url.indexOf("?");
  if (q < 0) return [];
  return url
    .slice(q + 1)
    .split("&")
    .flatMap((p) => {
      const eq = p.indexOf("=");
      return eq < 0 || KEEP.has(decodeURIComponent(p.slice(0, eq))) ? [] : [p.slice(eq + 1)];
    });
}

/** The URL with every query value but the public constants turned into `x`s of the same length. */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const pairs = url
    .slice(q + 1)
    .split("&")
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return p;
      const key = decodeURIComponent(p.slice(0, eq));
      return KEEP.has(key) ? p : `${p.slice(0, eq + 1)}${"x".repeat(p.length - eq - 1)}`;
    });
  return `${url.slice(0, q + 1)}${pairs.join("&")}`;
}

/** The values redacted one by one after the whole URL and the whole code: any copy the first passes missed. */
function secretParts(found: { url: string; code: string }): string[] {
  return [...urlValues(found.url), ...found.code.split("#")].filter((v) => v.length >= MIN_SECRET);
}

const TOKEN_PREFIX = "sk-ant-oat01-";
const SYNTHETIC = `${TOKEN_PREFIX}SYNTHETIC`;

/** A secret is still present after redaction. Carries no text from the transcript. */
export class RedactionFailed extends Error {
  constructor() {
    super("redaction_failed");
  }
}

/**
 * Same length out as in: the URL's query values, the code echo and every fragment of the token become synthetic
 * characters, every other byte is kept. The token becomes `sk-ant-oat01-SYNTHETIC` padded with `x`. Then checks the
 * result with `assertRedacted`, so a partial copy it could not find fails with `RedactionFailed`.
 */
export function redactTranscript(
  raw: string,
  found: { url: string; code: string; token: string },
): string {
  if (found.token.length < SYNTHETIC.length) throw new Error("token too short to redact");
  let out = replaceWrapped(raw, found.url, redactUrl(found.url));
  out = replaceWrapped(out, found.code, "x".repeat(found.code.length));
  for (const v of secretParts(found)) out = replaceWrapped(out, v, "x".repeat(v.length));
  out = replaceWrapped(out, found.token, SYNTHETIC.padEnd(found.token.length, "x"));
  assertRedacted(out, found);
  return out;
}

/**
 * Throws `RedactionFailed` if any non-public URL value of 8+ chars, or any 8-char fragment of the code, is left in
 * `text`, as is or with terminal codes, line breaks and spaces removed (a value split by a wrap or a cursor move).
 */
export function assertRedacted(text: string, found: { url: string; code: string }): void {
  const needles = urlValues(found.url).filter((v) => v.length >= MIN_SECRET);
  for (let i = 0; i + MIN_SECRET <= found.code.length; i++)
    needles.push(found.code.slice(i, i + MIN_SECRET));
  for (const hay of [text, stripNoise(text)])
    if (needles.some((n) => hay.includes(n))) throw new RedactionFailed();
}

const REAL_TOKEN = /sk-ant-oat01-(?!SYNTHETIC)/;

/**
 * Checks for a real-looking token (also one whose prefix is split by a wrap or a terminal code), then writes `<dir>/<name>` with mode 0600 (never overwriting) in a 0700 dir. A failed check writes and
 * creates nothing. Returns the path.
 */
export async function writeRecording(dir: string, name: string, text: string): Promise<string> {
  if (REAL_TOKEN.test(text) || REAL_TOKEN.test(stripNoise(text))) throw new RedactionFailed();
  if (name !== path.basename(name) || name.startsWith(".")) throw new Error("bad file name");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, name);
  await writeFile(file, text, { mode: 0o600, flag: "wx" });
  return file;
}
