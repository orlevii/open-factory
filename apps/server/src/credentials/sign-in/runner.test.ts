import { afterEach, describe, expect, it, vi } from "vitest";
import { RunFailed, runSetupToken } from "./setup-token.ts";

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
const PRE = "Browser didn't open? Use the url below to sign in (c to copy)";
const PROMPT = "Paste code here if prompted >";
const SCREEN = [PRE, COM, PROMPT].join("\n");
const TOK = `sk-ant-oat01-SYNTHETIC${"a".repeat(60)}`;
const BEFORE = "Your OAuth token (valid for 1 year):";
const AFTER = "Store this token securely. You won't be able to see it again.";

function fakePty() {
  let cb: (s: string) => void = () => {};
  const writes: string[] = [];
  let killed = 0;
  let resolveExit!: (v: { code: number | null }) => void;
  const exit = new Promise<{ code: number | null }>((r) => {
    resolveExit = r;
  });
  return {
    pty: {
      onData: (f: (s: string) => void) => {
        cb = f;
      },
      write: (s: string) => writes.push(s),
      kill: () => {
        killed++;
        resolveExit({ code: null });
      },
      exit,
      dir: "/tmp/x",
    },
    emit: (s: string) => cb(s),
    writes,
    killed: () => killed,
    exitWith: (c: number) => resolveExit({ code: c }),
  };
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof RunFailed ? e.reason : "other";
  }
  return "resolved";
};

async function submitted(settleMs = 150) {
  vi.useFakeTimers();
  const f = fakePty();
  const r = runSetupToken(f.pty, { settleMs });
  f.emit(SCREEN);
  await r.prompt;
  const p = r.submit("abc#def");
  await vi.advanceTimersByTimeAsync(settleMs);
  return { f, r, p };
}

afterEach(() => vi.useRealTimers());

describe("runSetupToken", () => {
  it("resolves the prompt across chunk boundaries", async () => {
    const f = fakePty();
    const r = runSetupToken(f.pty, { settleMs: 0 });
    f.emit(SCREEN.slice(0, 30));
    f.emit(SCREEN.slice(30));
    await expect(r.prompt).resolves.toEqual({ url: COM });
  });

  it("writes the code, then a separate CR after settleMs, and returns the token", async () => {
    vi.useFakeTimers();
    const f = fakePty();
    const r = runSetupToken(f.pty, { settleMs: 150 });
    f.emit(SCREEN);
    await r.prompt;
    const p = r.submit("abc#def");
    expect(f.writes).toEqual(["abc#def"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(f.writes).toEqual(["abc#def", "\r"]);
    f.emit(`${BEFORE}\n${TOK}\n${AFTER}\n`);
    await expect(p).resolves.toBe(TOK);
    expect(f.killed()).toBe(1);
  });

  it("finds a token split across chunks", async () => {
    const { f, p } = await submitted();
    const s = `${BEFORE}\n${TOK}\n${AFTER}\n`;
    f.emit(s.slice(0, 50));
    f.emit(s.slice(50, 120));
    f.emit(s.slice(120));
    await expect(p).resolves.toBe(TOK);
  });

  it("an OAuth error is code_rejected and kills", async () => {
    const { f, p } = await submitted();
    f.emit("OAuth error: invalid_grant");
    expect(await reason(p)).toBe("code_rejected");
    expect(f.killed()).toBe(1);
  });

  it("anchors around anything but a strict token end the attempt", async () => {
    const { f, p } = await submitted();
    f.emit(`${BEFORE}\nhello there\n${AFTER}\n`);
    expect(await reason(p)).toBe("exchange_failed");
    expect(f.killed()).toBe(1);
  });

  it("the after-anchor fails fast even when cursor moves separate its words", async () => {
    const { f, p } = await submitted();
    f.emit(`${BEFORE}\nhello there\n${AFTER.replaceAll(" ", "\x1b[1C")}\n`);
    expect(await reason(p)).toBe("exchange_failed");
    expect(f.killed()).toBe(1);
  });

  it("exit without a token is exchange_failed", async () => {
    const { f, p } = await submitted();
    f.exitWith(0);
    expect(await reason(p)).toBe("exchange_failed");
  });

  it("exit before the prompt is start_failed", async () => {
    const f = fakePty();
    const r = runSetupToken(f.pty);
    f.exitWith(1);
    expect(await reason(r.prompt)).toBe("start_failed");
    expect(f.killed()).toBe(1);
  });

  it("no prompt in 30 s is start_failed", async () => {
    vi.useFakeTimers();
    const f = fakePty();
    const r = runSetupToken(f.pty);
    await vi.advanceTimersByTimeAsync(29_999);
    f.emit("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(await reason(r.prompt)).toBe("start_failed");
    expect(f.killed()).toBe(1);
  });

  it("no token in 60 s is exchange_failed", async () => {
    const { f, p } = await submitted();
    await vi.advanceTimersByTimeAsync(59_999);
    f.emit("working");
    await vi.advanceTimersByTimeAsync(1);
    expect(await reason(p)).toBe("exchange_failed");
    expect(f.killed()).toBe(1);
  });

  it("abort in each state rejects with aborted and kills once", async () => {
    // starting
    let f = fakePty();
    let r = runSetupToken(f.pty);
    r.abort();
    r.abort();
    expect(await reason(r.prompt)).toBe("aborted");
    expect(f.killed()).toBe(1);

    // awaiting_code: a later submit is refused
    f = fakePty();
    r = runSetupToken(f.pty);
    f.emit(SCREEN);
    await r.prompt;
    r.abort();
    expect(await reason(r.submit("x"))).toBe("aborted");
    expect(f.writes).toEqual([]);
    expect(f.killed()).toBe(1);

    // settling: no CR is written
    vi.useFakeTimers();
    f = fakePty();
    r = runSetupToken(f.pty, { settleMs: 150 });
    f.emit(SCREEN);
    await r.prompt;
    const p = r.submit("abc");
    r.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(await reason(p)).toBe("aborted");
    expect(f.writes).toEqual(["abc"]);
    expect(f.killed()).toBe(1);

    // exchanging
    const e = await submitted();
    e.r.abort();
    e.r.abort();
    expect(await reason(e.p)).toBe("aborted");
    expect(e.f.killed()).toBe(1);

    // minted: abort is a no-op
    const m = await submitted();
    m.f.emit(`${BEFORE}\n${TOK}\n${AFTER}\n`);
    await m.p;
    m.r.abort();
    expect(m.f.killed()).toBe(1);
  });

  it("bounds the prompt buffer to 64 KB and still finds a later prompt", async () => {
    const f = fakePty();
    const r = runSetupToken(f.pty);
    for (let i = 0; i < 4; i++) f.emit("x".repeat(64 * 1024));
    f.emit(SCREEN);
    await expect(r.prompt).resolves.toEqual({ url: COM });
  });

  it("never puts CLI text in an error", async () => {
    const { f, p } = await submitted();
    f.emit(`OAuth error: ${TOK} abc#def ${COM}`);
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunFailed);
    expect(String(err)).toBe("Error: code_rejected");
    expect((err as Error).message).toBe("code_rejected");
    expect((err as Error).stack).not.toContain("abc#def");
  });
});
