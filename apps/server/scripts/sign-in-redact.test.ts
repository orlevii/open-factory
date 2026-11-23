import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrompt, parseToken } from "../src/credentials/sign-in/setup-token.ts";
import { RedactionFailed, redactTranscript, writeRecording } from "./sign-in-redact.ts";

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

  it("rejects a name that is not a plain file name", async () => {
    base = await mkdtemp(path.join(tmpdir(), "of-redact-test-"));
    await expect(writeRecording(base, "../x.txt", "a")).rejects.toThrow();
  });
});
