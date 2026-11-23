import { MSG } from "@open-factory/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELD_MSG } from "../../field-messages.ts";
import type { VerifyResult } from "../verify.ts";
import { isLive, SignInAttempts } from "./attempts.ts";
import { type PtyRun, PtyUnavailable } from "./host-pty.ts";
import { RunFailed, type SetupTokenRun } from "./setup-token.ts";

// Synthetic values only.
const URL_ = "https://claude.com/cai/oauth/authorize?state=SYNTHETIC-URL-STATE";
const CODE = "SYNTHETIC-CODE-123";
const TOKEN = `sk-ant-oat01-SYNTHETIC${"t".repeat(40)}`;
const DAY = 24 * 60 * 60_000;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function fakePty() {
  const writes: string[] = [];
  let kills = 0;
  const exit = deferred<{ code: number | null }>();
  const pty: PtyRun & { writes: string[]; kills: () => number } = {
    onData: () => {},
    write: (s) => writes.push(s),
    kill: () => {
      kills++;
      exit.resolve({ code: null });
    },
    exit: exit.promise,
    dir: "/tmp/of-sign-in-fake",
    writes,
    kills: () => kills,
  };
  return pty;
}

type FakeRun = {
  pty: ReturnType<typeof fakePty>;
  prompt: ReturnType<typeof deferred<{ url: string }>>;
  token: ReturnType<typeof deferred<string>>;
  aborted: () => boolean;
};

function store(
  o: {
    prompts?: boolean; // resolve the prompt at once (default true)
    startPty?: () => Promise<PtyRun>;
    verify?: (v: string) => Promise<VerifyResult>;
    nameTaken?: (n: string) => Promise<boolean>;
    byName?: (
      n: string,
    ) => Promise<{ id: string; name: string; kind: "oauth_token" | "api_key" } | undefined>;
    insertVerified?: (b: unknown) => Promise<unknown>;
    replaceVerified?: (id: string, v: string, opts: unknown) => Promise<unknown>;
    cap?: number;
  } = {},
) {
  const runs: FakeRun[] = [];
  const logs: { o: object; m: string }[] = [];
  const inserts: unknown[] = [];
  const replaces: unknown[] = [];
  const verifies: string[] = [];
  let n = 0;
  const s = new SignInAttempts({
    startPty: o.startPty ?? (async () => fakePty()),
    run(pty) {
      const p = pty as ReturnType<typeof fakePty>;
      const prompt = deferred<{ url: string }>();
      const token = deferred<string>();
      let aborted = false;
      let done = false;
      const r: FakeRun = { pty: p, prompt, token, aborted: () => aborted };
      runs.push(r);
      if (o.prompts !== false) prompt.resolve({ url: URL_ });
      const run: SetupTokenRun = {
        prompt: prompt.promise,
        submit(code) {
          p.write(code);
          return token.promise.finally(() => {
            done = true;
          });
        },
        abort() {
          if (done) return;
          done = true;
          aborted = true;
          prompt.reject(new RunFailed("aborted"));
          token.reject(new RunFailed("aborted"));
          p.kill();
        },
      };
      return run;
    },
    async verify(v) {
      verifies.push(v);
      return o.verify ? o.verify(v) : { ok: true };
    },
    credentials: {
      nameTaken: o.nameTaken ?? (async () => false),
      byName: (o.byName ??
        (async (name: string) => ({ id: "c1", name, kind: "oauth_token" }))) as never,
      insertVerified: (async (b: unknown) => {
        inserts.push(b);
        return o.insertVerified ? o.insertVerified(b) : { name: (b as { name: string }).name };
      }) as never,
      replaceVerified: (async (id: string, v: string, opts: unknown) => {
        replaces.push({ id, v, opts });
        return o.replaceVerified ? o.replaceVerified(id, v, opts) : { name: "personal" };
      }) as never,
    },
    now: () => Date.now(),
    cap: o.cap,
    newId: () => `att-${++n}`,
    log: { info: (obj, m) => logs.push({ o: obj, m }) },
  });
  return { s, runs, logs, inserts, replaces, verifies };
}

const never = () => () => new Promise<PtyRun>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SignInAttempts", () => {
  it("starting is reserved synchronously: a second start while starting is 409", async () => {
    const { s } = store({ startPty: never() });
    const first = s.start("u1", {});
    await expect(s.start("u1", {})).rejects.toMatchObject({ status: 409, code: "sign_in_state" });
    expect(s.view("u1")).toMatchObject({ state: "starting" });
    s.endFor("u1");
    // The pty never arrives; endFor still drops the reservation and the first start settles.
    await expect(first).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
    expect(s.view("u1")).toBeNull();
  });

  it("a pty that arrives after the attempt ended is killed at once", async () => {
    const pty = deferred<PtyRun>();
    const { s, runs } = store({ startPty: () => pty.promise });
    const first = s.start("u1", {});
    s.endFor("u1");
    await expect(first).rejects.toMatchObject({ code: "sign_in_not_found" });
    const late = fakePty();
    pty.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.kills()).toBe(1);
    expect(runs).toEqual([]);
  });

  it("an aborted start (endFor while the prompt is pending) is never a start failure", async () => {
    const { s, runs } = store({ prompts: false });
    const first = s.start("u1", {});
    await vi.advanceTimersByTimeAsync(0);
    s.endFor("u1");
    await expect(first).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
    expect(runs[0]?.aborted()).toBe(true);
    expect(runs[0]?.pty.kills()).toBeGreaterThan(0);
  });

  it("start answers awaiting_code with url and codeDeadline", async () => {
    const { s } = store();
    const a = await s.start("u1", {});
    expect(a).toEqual({
      attemptId: "att-1",
      state: "awaiting_code",
      url: URL_,
      codeDeadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      purpose: "create",
    });
  });

  it("start ends an awaiting_code attempt and makes a new attemptId", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    const b = await s.start("u1", {});
    expect(b.attemptId).not.toBe(a.attemptId);
    expect(runs[0]?.aborted()).toBe(true);
    expect(runs[1]?.aborted()).toBe(false);
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "x1" })).rejects.toMatchObject({
      status: 409,
      code: "sign_in_replaced",
    });
  });

  it("a failed prompt is 502 sign_in_start_failed and kills the pty", async () => {
    const { s, runs } = store({ prompts: false });
    const p = s.start("u1", {});
    await vi.advanceTimersByTimeAsync(0);
    runs[0]?.prompt.reject(new RunFailed("start_failed"));
    await expect(p).rejects.toMatchObject({ status: 502, code: "sign_in_start_failed" });
    expect(runs[0]?.pty.kills()).toBeGreaterThan(0);
    expect(s.view("u1")).toBeNull();
  });

  it("PtyUnavailable is 503 sign_in_unavailable", async () => {
    const { s } = store({ startPty: async () => Promise.reject(new PtyUnavailable()) });
    await expect(s.start("u1", {})).rejects.toMatchObject({
      status: 503,
      code: "sign_in_unavailable",
      message: MSG.signInUnavailable,
    });
    expect(s.view("u1")).toBeNull();
  });

  it("replace: unknown name is 404 credentialDeleted, api_key is 400 signInOAuthOnly", async () => {
    const gone = store({ byName: async () => undefined });
    await expect(gone.s.start("u1", { replace: "x" })).rejects.toMatchObject({
      status: 404,
      code: "credential_not_found",
      message: MSG.credentialDeleted,
    });
    const key = store({ byName: async (name) => ({ id: "k", name, kind: "api_key" }) });
    await expect(key.s.start("u1", { replace: "x" })).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
      message: MSG.signInOAuthOnly,
    });
    const ok = store();
    expect(await ok.s.start("u1", { replace: "personal" })).toMatchObject({
      purpose: "replace",
      name: "personal",
    });
  });

  it("the cap counts starting; the 4th user's start is 429 sign_in_busy", async () => {
    const { s } = store({ startPty: never() });
    for (const u of ["u1", "u2", "u3"]) s.start(u, {}).catch(() => {});
    await expect(s.start("u4", {})).rejects.toMatchObject({
      status: 429,
      code: "sign_in_busy",
      message: MSG.signInBusy,
    });
    expect(s.view("u4")).toBeNull();
  });

  it("the caller's own replaced attempt doesn't count against the cap", async () => {
    const { s } = store();
    for (const u of ["u1", "u2", "u3"]) await s.start(u, {});
    await expect(s.start("u3", {})).resolves.toMatchObject({ state: "awaiting_code" });
  });

  it("a submit in flight (submitting) holds its slot against the cap", async () => {
    const taken = deferred<boolean>();
    const { s } = store({ cap: 1, nameTaken: () => taken.promise });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    expect(s.view("u1")?.state).toBe("submitting");
    await expect(s.start("u2", {})).rejects.toMatchObject({ status: 429, code: "sign_in_busy" });
    taken.resolve(true);
    await expect(sub).rejects.toMatchObject({ code: "credential_exists" });
  });

  it("isLive is true for starting, awaiting_code, submitting, exchanging and verifying only", () => {
    for (const st of [
      "starting",
      "awaiting_code",
      "submitting",
      "exchanging",
      "verifying",
    ] as const)
      expect(isLive(st)).toBe(true);
    expect(isLive("settled")).toBe(false);
  });

  it("an attemptId mismatch is 409 sign_in_replaced and leaves the run untouched", async () => {
    const { s, runs } = store();
    await s.start("u1", {});
    await expect(s.submit("u1", "other", { code: CODE, name: "work" })).rejects.toMatchObject({
      status: 409,
      code: "sign_in_replaced",
      message: MSG.signInReplaced,
    });
    await expect(s.wait("u1", "other")).rejects.toMatchObject({ code: "sign_in_replaced" });
    await expect(s.cancel("u1", "other")).rejects.toMatchObject({ code: "sign_in_replaced" });
    expect(runs[0]?.pty.writes).toEqual([]);
    expect(runs[0]?.aborted()).toBe(false);
    expect(s.view("u1")?.state).toBe("awaiting_code");
  });

  it("another user with no attempt is 404 for code, wait and cancel whatever the id", async () => {
    const { s } = store();
    const a = await s.start("u1", {});
    for (const p of [
      s.submit("u2", a.attemptId, { code: CODE, name: "work" }),
      s.wait("u2", a.attemptId),
      s.cancel("u2", a.attemptId),
    ])
      await expect(p).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
    expect(s.view("u2")).toBeNull();
    expect(s.view("u1")?.state).toBe("awaiting_code");
  });

  it("name is checked before the code is written; failure returns to awaiting_code with the original deadline", async () => {
    const { s, runs } = store({ nameTaken: async () => true });
    const a = await s.start("u1", {});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(s.submit("u1", a.attemptId, { code: "abc", name: "work" })).rejects.toMatchObject({
      status: 409,
      code: "credential_exists",
    });
    expect(runs[0]?.pty.writes).toEqual([]);
    expect(s.view("u1")).toMatchObject({ state: "awaiting_code", codeDeadline: a.codeDeadline });
  });

  it("an invalid code or name is a 400 field error and keeps the attempt", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    await expect(s.submit("u1", a.attemptId, { code: " \n ", name: "work" })).rejects.toMatchObject(
      {
        status: 400,
        code: "validation_error",
        message: MSG.signInCode,
        extra: { fields: { code: MSG.signInCode } },
      },
    );
    await expect(
      s.submit("u1", a.attemptId, { code: CODE, name: "Bad Name" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
      extra: { fields: { name: MSG.startLetter } },
    });
    await expect(s.submit("u1", a.attemptId, { code: CODE })).rejects.toMatchObject({
      extra: { fields: { name: MSG.nameLength } },
    });
    expect(runs[0]?.pty.writes).toEqual([]);
    expect(s.view("u1")?.state).toBe("awaiting_code");
  });

  it("a second submit during submitting is 409 sign_in_state", async () => {
    const taken = deferred<boolean>();
    const { s } = store({ nameTaken: () => taken.promise });
    const a = await s.start("u1", {});
    const first = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "work" })).rejects.toMatchObject({
      status: 409,
      code: "sign_in_state",
    });
    taken.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.view("u1")?.state).toBe("exchanging");
    first.catch(() => {});
  });

  it("TTL while waiting kills, removes, tombstones: a late code is 410 for 60 s, then 404", async () => {
    const { s, runs, logs } = store();
    const a = await s.start("u1", {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs[0]?.aborted()).toBe(true);
    expect(s.view("u1")).toBeNull();
    expect(logs.at(-1)).toEqual({
      o: { userId: "u1", attemptId: a.attemptId, reason: "expired" },
      m: "sign-in ended",
    });
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "work" })).rejects.toMatchObject({
      status: 410,
      code: "sign_in_expired",
      message: MSG.signInExpired,
    });
    await expect(s.wait("u1", a.attemptId)).rejects.toMatchObject({ status: 410 });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "work" })).rejects.toMatchObject({
      status: 404,
      code: "sign_in_not_found",
    });
  });

  it("a name check that ends after the deadline expires the attempt", async () => {
    const taken = deferred<boolean>();
    const { s } = store({ nameTaken: () => taken.promise });
    const a = await s.start("u1", {});
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(5);
    expect(s.view("u1")?.state).toBe("submitting"); // the TTL can't fire mid-check
    taken.resolve(true);
    await expect(sub).rejects.toMatchObject({ code: "credential_exists" });
    expect(s.view("u1")).toBeNull();
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "w2" })).rejects.toMatchObject({
      status: 410,
    });
  });

  it("submit clears the TTL: an exchange past 10 minutes still saves", async () => {
    const { s, runs, inserts } = store();
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(runs[0]?.aborted()).toBe(false);
    runs[0]?.token.resolve(TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(inserts).toHaveLength(1);
    await expect(s.wait("u1", a.attemptId)).resolves.toMatchObject({ status: 201 });
    await expect(sub).resolves.toMatchObject({ state: "exchanging" }); // its 202 came at 50 s
  });

  it("verification unreachable is retried once after 3 s, then 502 claude_unreachable and the token is dropped", async () => {
    const { s, runs, verifies, inserts } = store({
      verify: async () => ({
        ok: false,
        kind: "unreachable",
        message: FIELD_MSG.claudeUnreachable,
      }),
    });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    sub.catch(() => {});
    runs[0]?.token.resolve(TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(verifies).toHaveLength(1);
    expect(s.view("u1")?.state).toBe("verifying");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(verifies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(verifies).toHaveLength(2);
    await expect(sub).rejects.toMatchObject({
      status: 502,
      code: "claude_unreachable",
      message: FIELD_MSG.claudeUnreachable,
    });
    expect(inserts).toEqual([]);
    expect(JSON.stringify(s.view("u1"))).not.toContain(TOKEN);
  });

  it("verification rejected is 422 sign_in_token_rejected with FIELD_MSG.tokenRejected", async () => {
    const { s, runs, verifies } = store({
      verify: async () => ({ ok: false, kind: "rejected", message: FIELD_MSG.tokenRejected }),
    });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await expect(sub).rejects.toMatchObject({
      status: 422,
      code: "sign_in_token_rejected",
      message: FIELD_MSG.tokenRejected,
    });
    expect(verifies).toHaveLength(1);
  });

  it("code_rejected is 422 sign_in_code_rejected; exchange_failed is 502 sign_in_failed", async () => {
    for (const [reason, status, code, message] of [
      ["code_rejected", 422, "sign_in_code_rejected", MSG.signInCodeRejected],
      ["exchange_failed", 502, "sign_in_failed", MSG.signInFailed],
    ] as const) {
      const { s, runs } = store();
      const a = await s.start("u1", {});
      const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
      runs[0]?.token.reject(new RunFailed(reason));
      await expect(sub).rejects.toMatchObject({ status, code, message });
      expect(s.view("u1")?.state).toBe("settled");
    }
  });

  it("create saves with expiresAt = token time + 365 d; replace uses replaceVerified by id", async () => {
    const c = store();
    const a = await c.s.start("u1", {});
    const sub = c.s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    expect(c.runs[0]?.pty.writes).toEqual([]); // the name check comes first
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.runs[0]?.pty.writes).toEqual([CODE]);
    const tokenAt = Date.now();
    c.runs[0]?.token.resolve(TOKEN);
    await expect(sub).resolves.toEqual({ status: 201, credential: { name: "work" } });
    expect(c.inserts).toEqual([
      { name: "work", kind: "oauth_token", value: TOKEN, expiresAt: new Date(tokenAt + 365 * DAY) },
    ]);

    const r = store();
    const b = await r.s.start("u1", { replace: "personal" });
    const rsub = r.s.submit("u1", b.attemptId, { code: CODE, name: "ignored" });
    await vi.advanceTimersByTimeAsync(0);
    r.runs[0]?.token.resolve(TOKEN);
    await expect(rsub).resolves.toEqual({ status: 200, credential: { name: "personal" } });
    expect(r.replaces).toEqual([
      { id: "c1", v: TOKEN, opts: { expiresAt: new Date(Date.now() + 365 * DAY) } },
    ]);
    expect(r.inserts).toEqual([]);
  });

  it("replace whose credential was deleted fails before the code is written (404, attempt ends)", async () => {
    let present = true;
    const { s, runs } = store({
      byName: async (name) => (present ? { id: "c1", name, kind: "oauth_token" } : undefined),
    });
    const a = await s.start("u1", { replace: "personal" });
    present = false;
    await expect(s.submit("u1", a.attemptId, { code: CODE })).rejects.toMatchObject({
      status: 404,
      code: "credential_not_found",
      message: MSG.credentialDeleted,
    });
    expect(runs[0]?.pty.writes).toEqual([]);
    expect(runs[0]?.aborted()).toBe(true);
    expect(s.view("u1")).toBeNull();
  });

  it("replace whose credential was re-created under the same name fails (another id)", async () => {
    let id = "c1";
    const { s } = store({ byName: async (name) => ({ id, name, kind: "oauth_token" }) });
    const a = await s.start("u1", { replace: "personal" });
    id = "c2";
    await expect(s.submit("u1", a.attemptId, { code: CODE })).rejects.toMatchObject({
      status: 404,
      code: "credential_not_found",
    });
  });

  it("a name race at insert is 409 sign_in_name_taken and ends the attempt", async () => {
    const { ApiError } = await import("../../errors.ts");
    const { s, runs } = store({
      insertVerified: async () => {
        throw new ApiError(409, "credential_exists", "A credential named work already exists.");
      },
    });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await expect(sub).rejects.toMatchObject({
      status: 409,
      code: "sign_in_name_taken",
      message: MSG.signInNameTaken,
    });
    expect(s.view("u1")?.state).toBe("settled");
    await expect(s.submit("u1", a.attemptId, { code: CODE, name: "w2" })).rejects.toMatchObject({
      code: "sign_in_state",
    });
  });

  it("an unexpected error while saving is 502 sign_in_failed, never its own text", async () => {
    const { s, runs } = store({
      insertVerified: async () => {
        throw new Error(`db exploded ${TOKEN}`);
      },
    });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await expect(sub).rejects.toMatchObject({
      status: 502,
      code: "sign_in_failed",
      message: MSG.signInFailed,
    });
  });

  it("submit waits up to waitMs then answers the AttemptView (202); wait returns the outcome later", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(sub).resolves.toEqual({
      attemptId: a.attemptId,
      state: "exchanging",
      purpose: "create",
      name: "work",
    });
    const w = s.wait("u1", a.attemptId);
    await vi.advanceTimersByTimeAsync(10_000);
    runs[0]?.token.resolve(TOKEN);
    await expect(w).resolves.toMatchObject({ status: 201, credential: { name: "work" } });
    // A second waiter (a reload) gets the same outcome.
    await expect(s.wait("u1", a.attemptId)).resolves.toMatchObject({ status: 201 });
  });

  it("wait on awaiting_code is 409 sign_in_state with the attempt", async () => {
    const { s } = store();
    const a = await s.start("u1", {});
    await expect(s.wait("u1", a.attemptId)).rejects.toMatchObject({
      status: 409,
      code: "sign_in_state",
      extra: { attempt: { attemptId: a.attemptId, state: "awaiting_code" } },
    });
  });

  it("only view and start carry the url; the wait 409 and the 202 views omit it", async () => {
    const { s } = store();
    const a = await s.start("u1", {});
    expect(a.url).toBe(URL_);
    expect(s.view("u1")?.url).toBe(URL_);
    const e = await s.wait("u1", a.attemptId).catch((x) => x);
    expect(e.extra.attempt.url).toBeUndefined();
    expect(e.extra.attempt.codeDeadline).toBeDefined();
    const sub = store();
    const b = await sub.s.start("u1", {});
    const submitted = sub.s.submit("u1", b.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(0);
    const waited = sub.s.wait("u1", b.attemptId);
    await vi.advanceTimersByTimeAsync(50_001);
    for (const w of [await submitted, await waited]) {
      expect(w).toMatchObject({ state: "exchanging" });
      expect((w as { url?: string }).url).toBeUndefined();
    }
  });

  it("a replace lookup failure propagates, not 404, and leaves no attempt", async () => {
    const boom = new Error("db down");
    const { s } = store({
      byName: async () => {
        throw boom;
      },
    });
    await expect(s.start("u1", { replace: "x" })).rejects.toBe(boom);
    expect(s.view("u1")).toBeNull();
  });

  it("wait during submitting follows the name check", async () => {
    const taken = deferred<boolean>();
    const { s } = store({ nameTaken: () => taken.promise });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    sub.catch(() => {});
    const w = s.wait("u1", a.attemptId);
    taken.resolve(true);
    await expect(w).rejects.toMatchObject({
      code: "sign_in_state",
      extra: { attempt: { state: "awaiting_code" } },
    });
  });

  it("the settled outcome is kept keepMs, then wait is 404", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await sub;
    expect(s.view("u1")).toEqual({
      attemptId: a.attemptId,
      state: "settled",
      purpose: "create",
      name: "work",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(s.wait("u1", a.attemptId)).resolves.toMatchObject({ status: 201 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(s.wait("u1", a.attemptId)).rejects.toMatchObject({ status: 404 });
    expect(s.view("u1")).toBeNull();
  });

  it("start, cancel and endFor drop a settled attempt", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await sub;
    expect((await s.start("u1", {})).attemptId).not.toBe(a.attemptId);
    s.endFor("u1");
    expect(s.view("u1")).toBeNull();
  });

  it("cancel ends awaiting_code and aborts starting; it is idempotent after expiry", async () => {
    const { s, runs } = store();
    const a = await s.start("u1", {});
    await s.cancel("u1", a.attemptId);
    expect(runs[0]?.aborted()).toBe(true);
    expect(s.view("u1")).toBeNull();
    await expect(s.cancel("u1", a.attemptId)).rejects.toMatchObject({ status: 404 });

    const b = await s.start("u1", {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(s.cancel("u1", b.attemptId)).resolves.toBeUndefined();
  });

  it("cancel and start are refused in exchanging/verifying; endFor leaves them alone", async () => {
    const verified = deferred<VerifyResult>();
    const { s, runs, inserts } = store({ verify: () => verified.promise });
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.view("u1")?.state).toBe("exchanging");
    await expect(s.cancel("u1", a.attemptId)).rejects.toMatchObject({
      status: 409,
      code: "sign_in_state",
    });
    await expect(s.start("u1", {})).rejects.toMatchObject({ status: 409, code: "sign_in_state" });
    s.endFor("u1");
    runs[0]?.token.resolve(TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.view("u1")?.state).toBe("verifying");
    await expect(s.cancel("u1", a.attemptId)).rejects.toMatchObject({ code: "sign_in_state" });
    await expect(s.start("u1", {})).rejects.toMatchObject({ code: "sign_in_state" });
    s.endFor("u1");
    verified.resolve({ ok: true });
    await expect(sub).resolves.toMatchObject({ status: 201 });
    expect(inserts).toHaveLength(1);
  });

  it("endFor ends awaiting_code", async () => {
    const { s, runs } = store();
    await s.start("u1", {});
    s.endFor("u1");
    expect(runs[0]?.aborted()).toBe(true);
    expect(s.view("u1")).toBeNull();
  });

  it("closeAll kills every pty", async () => {
    const { s, runs } = store();
    await s.start("u1", {});
    const b = await s.start("u2", {});
    const sub = s.submit("u2", b.attemptId, { code: CODE, name: "work" });
    await vi.advanceTimersByTimeAsync(0);
    await s.closeAll();
    for (const r of runs) expect(r.pty.kills()).toBeGreaterThan(0);
    expect(s.view("u1")).toBeNull();
    expect(s.view("u2")).toBeNull();
    // The exchange's aborted run is not a user error (no sign_in_failed).
    await expect(sub).rejects.toMatchObject({ status: 404, code: "sign_in_not_found" });
  });

  it("never logs the URL, code or token", async () => {
    const { s, runs, logs } = store();
    const a = await s.start("u1", {});
    const sub = s.submit("u1", a.attemptId, { code: CODE, name: "work" });
    runs[0]?.token.resolve(TOKEN);
    await sub;
    await s.start("u1", {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const text = JSON.stringify(logs);
    for (const secret of [URL_, CODE, TOKEN]) expect(text).not.toContain(secret);
    for (const l of logs) {
      expect(["sign-in started", "sign-in ended"]).toContain(l.m);
      expect(Object.keys(l.o).sort()).toEqual(["attemptId", "reason", "userId"]);
    }
    expect(logs.map((l) => (l.o as { reason: string }).reason)).toEqual([
      "started",
      "saved",
      "started",
      "expired",
    ]);
  });
});
