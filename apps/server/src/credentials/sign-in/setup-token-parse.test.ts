import { describe, expect, it } from "vitest";
import { hasOAuthError, parsePrompt, parseToken, stripTerminal } from "./setup-token.ts";

const Q = [
  "client_id=9d1c8f00-1a2b-3c4d-5e6f-708192a3b4c5",
  "code=true",
  "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method=S256",
  `redirect_uri=${encodeURIComponent("https://platform.claude.com/oauth/code/callback")}`,
  "response_type=code",
  `scope=${encodeURIComponent("user:inference")}`,
  "state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us",
].join("&");
const COM = `https://claude.com/cai/oauth/authorize?${Q}`;
const AI = `https://claude.ai/oauth/authorize?${Q}`;
const PRE = "Browser didn't open? Use the url below to sign in (c to copy)";
const PROMPT = "Paste code here if prompted >";
const out = (url: string, ...extra: string[]) => [PRE, url, ...extra, PROMPT].join("\n");

describe("stripTerminal", () => {
  it("replaces OSC 8 with its URI, drops other OSC and CSI, spaces cursor moves, normalises CR", () => {
    const s =
      "\x1b]0;title\x07a\x1b[3Gb\x1b[2Cc\x1b[1;31md\x1b[0m\r\ne\rf\x1b]8;;https://x.test/\x1b\\shown\x1b]8;;\x1b\\";
    expect(stripTerminal(s)).toBe("a b cd\ne\nfhttps://x.test/");
  });
});

describe("parsePrompt", () => {
  it.each([COM, AI])("accepts %s", (u) => expect(parsePrompt(out(u))?.url).toBe(u));
  it("reads the URI of an OSC 8 link, not its wrapped text", () => {
    const link = `\x1b]8;;${COM}\x1b\\${COM.slice(0, 50)}\n${COM.slice(50, 90)}\x1b]8;;\x1b\\`;
    expect(parsePrompt([PRE, link, PROMPT].join("\n"))?.url).toBe(COM);
  });
  it("joins a hard-wrapped URL", () =>
    expect(parsePrompt([PRE, ...AI.match(/.{1,64}/g)!, PROMPT].join("\n"))?.url).toBe(AI));
  it("skips repeats and the copy hint", () =>
    expect(
      parsePrompt(out(COM, COM, "Hold Shift while selecting to use your terminal's native copy."))
        ?.url,
    ).toBe(COM));
  it.each([
    ["look-alike host", COM.replace("claude.com", "claude.com.evil.io")],
    ["mixed case", COM.replace("claude.com", "Claude.com")],
    ["punycode", COM.replace("claude.com", "xn--claude-9ya.com")],
    ["port", COM.replace("claude.com", "claude.com:443")],
    ["userinfo", COM.replace("https://", "https://a@")],
    ["fragment", `${COM}#x`],
    ["duplicate key", `${COM}&state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us`],
    ["missing key", COM.replace(/&state=[^&]+/, "")],
    ["wrong redirect", COM.replace("platform.claude.com", "evil.io")],
    ["five extra keys", `${COM}&a=1&b=1&c=1&d=1&e=1`],
    ["sk-ant in a value", `${COM}&x=sk-ant-oops`],
    ["sk-ant in a decoded key", `${COM}&sk%2Dant%2Dx=1`],
  ])("refuses %s", (_n, u) => expect(parsePrompt(out(u))).toBeNull());
  it("refuses a prompt sharing prose or on the wrong line", () => {
    expect(parsePrompt([PRE, COM, "Paste code here if prompted, or not"].join("\n"))).toBeNull();
    expect(parsePrompt([PRE, COM, "something", PROMPT].join("\n"))).toBeNull();
  });
  it("refuses a URL more than 512 characters after the preamble", () =>
    expect(parsePrompt([PRE, "x".repeat(600), COM, PROMPT].join("\n"))).toBeNull());
});

const TOK = `sk-ant-oat01-SYNTHETIC${"a".repeat(60)}`;
const BEFORE = "Your OAuth token (valid for 1 year):";
const AFTER = "Store this token securely. You won't be able to see it again.";

describe("parseToken", () => {
  it("reads a wrapped, CR-joined token", () =>
    expect(parseToken(`${BEFORE}\r${TOK.slice(0, 40)}\r\n${TOK.slice(40)}\r${AFTER}`)).toBe(TOK));
  it.each([
    ["outside anchors", `${TOK}\n${BEFORE}\n${AFTER}`],
    ["anchors twice", `${BEFORE}\n${TOK}\n${AFTER}\n${BEFORE}\n${TOK}\n${AFTER}`],
    ["out of order", `${AFTER}\n${TOK}\n${BEFORE}`],
    ["prose between", `${BEFORE}\n${TOK}\nhello there\n${AFTER}`],
    ["wrong prefix", `${BEFORE}\nsk-ant-api03-${"a".repeat(40)}\n${AFTER}`],
    ["too short", `${BEFORE}\nsk-ant-oat01-abc\n${AFTER}`],
  ])("refuses a token %s", (_n, s) => expect(parseToken(s)).toBeNull());
});

describe("hasOAuthError", () => {
  it("detects an OAuth error through colours", () =>
    expect(hasOAuthError("\x1b[31mOAuth error:\x1b[0m Invalid code")).toBe(true));
  it("is false without one", () => expect(hasOAuthError("all good")).toBe(false));
});
