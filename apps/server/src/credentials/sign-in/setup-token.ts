// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
// Spec §5.3. Pure parsers for the `claude setup-token` terminal screen. None of these throw, log or echo their input:
// the buffer can hold the sign-in URL and the minted token.

export const AUTH_URLS = [
  "https://claude.ai/oauth/authorize",
  "https://claude.com/cai/oauth/authorize",
] as const;
export const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const TOKEN_BEFORE = "Your OAuth token (valid for 1 year):";
export const TOKEN_AFTER = "Store this token securely. You won't be able to see it again.";

const PREAMBLE = /the url below to sign in/i;
const URL_START = /^https:\/\/claude\.(?:ai|com)\//;
const URL_LINE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const PROMPT_LINE = /^Paste code here if prompted[>* ]*$/;
const COPY_HINT = /^Hold Shift while selecting/i;
const TOKEN_LINE = /^[A-Za-z0-9_-]+$/;
const TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

const URL_WINDOW = 512;
const MAX_URL_LINES = 16;
const MAX_URL_CHARS = 2048;
const MAX_EXTRA_KEYS = 4;

/** Terminal escape codes out, plain text in. Ink lays words out by column, so cursor moves become one space. */
export function stripTerminal(text: string): string {
  return text
    .replace(
      /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;[^;\x1b\x07]*;(?:\x1b\\|\x07)/g,
      "$1",
    )
    .replace(/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\[[0-9;]*[GC]/g, " ")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n|\r/g, "\n");
}

const REQUIRED: Record<string, (v: string) => boolean> = {
  client_id: (v) => /^[A-Za-z0-9._~-]{1,128}$/.test(v),
  code: (v) => /^[A-Za-z0-9._~-]{1,1024}$/.test(v),
  code_challenge: (v) => /^[A-Za-z0-9_-]{43,128}$/.test(v),
  code_challenge_method: (v) => v === "S256",
  redirect_uri: (v) => v === REDIRECT_URI,
  response_type: (v) => v === "code",
  scope: (v) => {
    if (v.length > 512) return false;
    const tokens = v.split(" ");
    return tokens.length <= 8 && tokens.every((t) => /^[A-Za-z0-9:._-]{1,64}$/.test(t));
  },
  state: (v) => /^[A-Za-z0-9_-]{16,256}$/.test(v),
};

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Fail closed: exact origin and path, each required key once with its value pattern, a few harmless extras. */
function validUrl(url: string): boolean {
  if (url.length > MAX_URL_CHARS || url.toLowerCase().includes("sk-ant-") || url.includes("#"))
    return false;
  const base = AUTH_URLS.find((u) => url.startsWith(`${u}?`));
  if (!base) return false;
  const seen = new Set<string>();
  let extra = 0;
  for (const pair of url.slice(base.length + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 1) return false;
    const key = decode(pair.slice(0, eq));
    const value = decode(pair.slice(eq + 1).replace(/\+/g, "%20"));
    if (key === null || value === null) return false;
    if ((key + value).toLowerCase().includes("sk-ant-") || seen.has(key)) return false;
    seen.add(key);
    const check = Object.hasOwn(REQUIRED, key) ? REQUIRED[key] : undefined;
    if (check) {
      if (!check(value)) return false;
    } else {
      if (++extra > MAX_EXTRA_KEYS) return false;
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || !/^[\x20-\x7E]{0,256}$/.test(value)) return false;
    }
  }
  return Object.keys(REQUIRED).every((k) => seen.has(k));
}

export function parsePrompt(buf: string): { url: string } | null {
  const lines = stripTerminal(buf)
    .split("\n")
    .map((l) => l.trim());
  const pre = lines.findIndex((l) => PREAMBLE.test(l));
  if (pre < 0) return null;
  let offset = 0;
  let start = -1;
  for (let i = pre + 1; i < lines.length && offset <= URL_WINDOW; i++) {
    if (URL_START.test(lines[i]!)) {
      start = i;
      break;
    }
    offset += lines[i]!.length + 1;
  }
  if (start < 0) return null;

  // Join URL-only lines until the string validates. A hard-wrapped URL can validate with its last value cut short, so
  // while the lines so far are all full-width wraps, keep joining as long as the longer string still validates.
  const width = lines[start]!.length;
  let url = "";
  let joined = "";
  let end = start;
  for (let i = start; i < lines.length && i - start < MAX_URL_LINES; i++) {
    const line = lines[i]!;
    if (!URL_LINE.test(line) || (i > start && URL_START.test(line))) break;
    if (url && (i === start + 1 || lines[i - 1]!.length !== width)) break;
    joined += line;
    if (joined.length > MAX_URL_CHARS) return null;
    if (validUrl(joined)) {
      url = joined;
      end = i + 1;
    } else if (url) break;
  }
  if (!url) return null;

  for (let i = end; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "" || line === url || COPY_HINT.test(line)) continue;
    return PROMPT_LINE.test(line) ? { url } : null;
  }
  return null;
}

export function parseToken(buf: string): string | null {
  const lines = stripTerminal(buf)
    .split("\n")
    .map((l) => l.trim());
  const before = lines.flatMap((l, i) => (l === TOKEN_BEFORE ? [i] : []));
  const after = lines.flatMap((l, i) => (l === TOKEN_AFTER ? [i] : []));
  if (before.length !== 1 || after.length !== 1 || before[0]! >= after[0]!) return null;
  const body = lines.slice(before[0]! + 1, after[0]!).filter((l) => l !== "");
  if (!body.every((l) => TOKEN_LINE.test(l))) return null;
  const token = body.join("");
  return TOKEN.test(token) ? token : null;
}

export function hasOAuthError(buf: string): boolean {
  return /OAuth\s+error\s*:/.test(stripTerminal(buf));
}
