// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
// Spec §11.3. Pure helpers for the recording script: redact a raw `claude setup-token` transcript, then write it. Nothing
// here logs; the transcript holds the sign-in URL, the code and a real token until redaction has run.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** What can sit between two characters of a wrapped value: a line break, indentation, a cursor move or an OSC. */
const NOISE_SRC =
  "(?:\\x1b\\][^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)|\\x1b\\[[0-?]*[ -/]*[@-~]|[ \\r\\n])";
const NOISE_STICKY = new RegExp(NOISE_SRC, "y");
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * Replaces every occurrence of `secret` (also when wrapped or split by terminal codes) with `replacement`, character
 * for character, and leaves the interleaved codes as they were. Both strings must be the same length and `secret`
 * must contain no ESC, CR, LF or space.
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
        out += match.slice(i, i + len);
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

const TOKEN_PREFIX = "sk-ant-oat01-";
const SYNTHETIC = `${TOKEN_PREFIX}SYNTHETIC`;

/**
 * Same length out as in: the URL's query values, the code echo and every fragment of the token become synthetic
 * characters, every other byte is kept. The token becomes `sk-ant-oat01-SYNTHETIC` padded with `x`.
 */
export function redactTranscript(
  raw: string,
  found: { url: string; code: string; token: string },
): string {
  if (found.token.length < SYNTHETIC.length) throw new Error("token too short to redact");
  let out = replaceWrapped(raw, found.url, redactUrl(found.url));
  out = replaceWrapped(out, found.code, "x".repeat(found.code.length));
  return replaceWrapped(out, found.token, SYNTHETIC.padEnd(found.token.length, "x"));
}

/** A real-looking token is still present. Carries no text from the transcript. */
export class RedactionFailed extends Error {
  constructor() {
    super("redaction_failed");
  }
}

const REAL_TOKEN = /sk-ant-oat01-(?!SYNTHETIC)/;

/**
 * Checks, then writes `<dir>/<name>` with mode 0600 (never overwriting) in a 0700 dir. A failed check writes and
 * creates nothing. Returns the path.
 */
export async function writeRecording(dir: string, name: string, text: string): Promise<string> {
  if (REAL_TOKEN.test(text)) throw new RedactionFailed();
  if (name !== path.basename(name) || name.startsWith(".")) throw new Error("bad file name");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, name);
  await writeFile(file, text, { mode: 0o600, flag: "wx" });
  return file;
}
