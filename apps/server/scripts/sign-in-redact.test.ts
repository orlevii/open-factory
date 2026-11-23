import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrompt, parseToken } from "../src/credentials/sign-in/setup-token.ts";
import {
  assertRedacted,
  RedactionFailed,
  redactTranscript,
  writeRecording,
} from "./sign-in-redact.ts";

const STATE = "stateSTATEstate1234567890abcdef";
const CHALLENGE = "chalCHALchalCHAL1234567890abcdefghijklmnopq";
const CLIENT = "client-id-0000-1111";
const CODE = "codeCODEcode0987654321zyx";
const QUERY = [
  ["code", "true"],
  ["client_id", CLIENT],
  ["response_type", "code"],
  ["redirect_uri", "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"],
  ["scope", "user%3Ainference%20user%3Aprofile"],
  ["code_challenge", CHALLENGE],
  ["code_challenge_method", "S256"],
  ["state", STATE],
];
const URL_ = `https://claude.ai/oauth/authorize?${QUERY.map(([k, v]) => `${k}=${v}`).join("&")}`;
const TOKEN = `sk-ant-oat01-REALLOOKING${"AbC0_-".repeat(14)}`;
const found = { url: URL_, code: CODE, token: TOKEN };
const SECRET_VALUES = [CLIENT, CHALLENGE, STATE, CODE];

function wrap(s: string, w: number, sep = "\r\n"): string {
  return s.match(new RegExp(`.{1,${w}}`, "g"))?.join(sep) ?? s;
}

function transcript(): string {
  const osc = `\x1b]8;;${URL_}\x1b\\${wrap(URL_, 60)}\x1b]8;;\x1b\\`;
  return [
    "Welcome\r\n",
    "Use the url below to sign in\r\n\r\n",
    `${osc}\r\n\r\n`,
    "Paste code here if prompted >\r\n",
    `${CODE}\x1b[1C\r\n`,
    "\r\nYour OAuth token (valid for 1 year):\r\n\r\n",
    `${wrap(TOKEN, 50)}\r\n\r\n`,
    "Store this token securely. You won't be able to see it again.\r\n",
  ].join("");
}

describe("redactTranscript", () => {
  const raw = transcript();
  const out = redactTranscript(raw, found);

  it("sanity: the synthetic transcript parses before redaction", () => {
    expect(parsePrompt(raw)?.url).toBe(URL_);
    expect(parseToken(raw)).toBe(TOKEN);
  });

  it("keeps the length", () => {
    expect(out.length).toBe(raw.length);
  });

  it("leaves no query value, code or token fragment", () => {
    for (const v of SECRET_VALUES) expect(out).not.toContain(v);
    expect(out).not.toContain("REALLOOKING");
    expect(out).not.toContain(TOKEN.slice(20, 40));
    expect(out).not.toMatch(/sk-ant-oat01-(?!SYNTHETIC)/);
  });

  it("redacts the OSC 8 URI and the wrapped display text alike", () => {
    expect(out).not.toContain(CHALLENGE.slice(0, 20));
    expect(out.match(/code_challenge=x{43}/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("still parses, with a synthetic token", () => {
    expect(parsePrompt(out)).not.toBeNull();
    const t = parseToken(out);
    expect(t?.startsWith("sk-ant-oat01-SYNTHETIC")).toBe(true);
    expect(t?.length).toBe(TOKEN.length);
  });

  it("keeps every other byte", () => {
    expect(out).toContain("Use the url below to sign in\r\n");
    expect(out).toContain("\x1b[1C\r\n");
    expect(out).toContain("Store this token securely.");
  });
});

/** wrap-ansi's shape: every wrapped line is its own OSC 8 hyperlink, re-opened with the full URI. */
function perLineLinks(term: string): string {
  const open = `\x1b]8;;${URL_}${term}`;
  const close = `\x1b]8;;${term}`;
  return wrap(URL_, 60)
    .split("\r\n")
    .map((line) => `${open}${line}${close}`)
    .join("\r\n  ");
}

describe.each([
  ["BEL", "\x07"],
  ["ST", "\x1b\\"],
])("redactTranscript with a hyperlink re-opened per wrapped line (%s)", (_, term) => {
  const raw = `Use the url below to sign in\r\n\r\n  ${perLineLinks(term)}\r\n\r\nPaste code here if prompted >\r\n${CODE}\r\n${wrap(TOKEN, 50)}\r\n`;
  const out = redactTranscript(raw, found);

  it("redacts every copy of the URI and keeps the length", () => {
    expect(parsePrompt(raw)?.url).toBe(URL_);
    expect(out.length).toBe(raw.length);
    for (const v of SECRET_VALUES) expect(out).not.toContain(v);
    expect(out.match(/state=x{31}/g)?.length).toBe(raw.split(`state=${STATE}`).length - 1);
    expect(raw.split(`state=${STATE}`).length - 1).toBeGreaterThanOrEqual(4); // one per line
    expect(parsePrompt(out)).not.toBeNull();
    expect(out).not.toMatch(/sk-ant-oat01-(?!SYNTHETIC)/);
    expect(out).toContain("sk-ant-oat01-SYNTHETIC");
  });
});

describe("post-redaction checks", () => {
  it("fails on a partial echo of the code it could not match whole", () => {
    const raw = `${transcript()}input> \u2026${CODE.slice(-12)}\r\n`;
    expect(() => redactTranscript(raw, found)).toThrow(RedactionFailed);
  });

  it("fails on a code fragment split by a wrap or a cursor move", () => {
    const frag = CODE.slice(3, 15);
    expect(() =>
      assertRedacted(`a ${frag.slice(0, 5)}\r\n  \x1b[2C${frag.slice(5)} b`, found),
    ).toThrow(RedactionFailed);
  });

  it("fails on a URL value left as is, or split by a wrap", () => {
    expect(() => assertRedacted(`state=${STATE}`, found)).toThrow(RedactionFailed);
    expect(() =>
      assertRedacted(`${CHALLENGE.slice(0, 9)}\r\n${CHALLENGE.slice(9)}`, found),
    ).toThrow(RedactionFailed);
    expect(() => assertRedacted(`\x1b]8;;x?client_id=${CLIENT}\x07`, found)).toThrow(
      RedactionFailed,
    );
  });

  it("passes clean text, and the error carries no transcript text", () => {
    expect(() => assertRedacted("state=xxxx code_challenge=xxxx true S256", found)).not.toThrow();
    const err = (() => {
      try {
        assertRedacted(STATE, found);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toBe("redaction_failed");
  });
});

describe("writeRecording", () => {
  let base: string;
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("writes 0600 in a 0700 dir, and never overwrites", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    const dir = path.join(base, "rec");
    await mkdir(dir, { mode: 0o755 });
    const file = await writeRecording(dir, "t.txt", "sk-ant-oat01-SYNTHETICxxxx");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("sk-ant-oat01-SYNTHETICxxxx");
    await expect(writeRecording(dir, "t.txt", "again")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("sk-ant-oat01-SYNTHETICxxxx");
  });

  it("creates a missing dir as 0700", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    const dir = path.join(base, "new");
    await writeRecording(dir, "t.txt", "hello");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("writes nothing when a real-looking token is left", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    const dir = path.join(base, "none");
    const err = await writeRecording(dir, "t.txt", `x ${TOKEN}`).catch((e) => e);
    expect(err).toBeInstanceOf(RedactionFailed);
    expect(err.message).not.toContain("REALLOOKING");
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("writes nothing when a token's prefix is split by a wrap or a terminal code", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    const dir = path.join(base, "none");
    for (const text of [`x sk-ant-o\r\nat01-REAL`, `x sk-ant-\x1b[1Coat01-REAL`]) {
      await expect(writeRecording(dir, "t.txt", text)).rejects.toBeInstanceOf(RedactionFailed);
    }
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("rejects a name that is not a plain file name", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    await expect(writeRecording(base, "../x.txt", "a")).rejects.toThrow();
  });
});
