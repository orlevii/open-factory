import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schema } from "@open-factory/db";
import { MSG } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { signUp } from "../test/helpers.ts";
import {
  appWithFakeClaude,
  SYNTHETIC_CODE,
  SYNTHETIC_TOKEN,
  SYNTHETIC_URL,
} from "../test/sign-in-helpers.ts";

// Spec §5.5, AC1, AC5, AC6, AC8, AC10. The fake CLI only: the real `claude` never runs.
const hasPython = spawnSync("python3", ["--version"]).status === 0;
if (!hasPython && process.env.CI)
  throw new Error("python3 is required for the sign-in route tests");

type Harness = Awaited<ReturnType<typeof appWithFakeClaude>>;

async function setup(o: Parameters<typeof appWithFakeClaude>[0] = {}): Promise<Harness> {
  const h = await appWithFakeClaude(o);
  onTestFinished(async () => {
    await h.app.signIn.closeAll();
    await h.t.close();
  });
  return h;
}

const call = (
  h: { app: Harness["app"] },
  cookie: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: object,
) => h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const YEAR_MS = 364 * 86400_000;

describe.skipIf(!hasPython)("claude sign-in routes (fake CLI)", () => {
  it("every route requires a signed-in user", async () => {
    const h = await setup();
    for (const [method, url] of [
      ["GET", "/api/claude-sign-in"],
      ["POST", "/api/claude-sign-in"],
      ["POST", "/api/claude-sign-in/code"],
      ["POST", "/api/claude-sign-in/code/wait"],
      ["DELETE", "/api/claude-sign-in/x"],
    ] as const)
      expect((await h.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
  });

  it("signs in and creates a credential (AC1)", async () => {
    const h = await setup();
    const { app, cookie } = h;
    const g = await call(h, cookie, "GET", "/api/claude-sign-in");
    expect(g.json()).toEqual({ available: true, attempt: null });
    const s = await call(h, cookie, "POST", "/api/claude-sign-in", {});
    expect(s.statusCode).toBe(200);
    const { attempt } = s.json();
    expect(attempt).toMatchObject({
      state: "awaiting_code",
      purpose: "create",
      url: SYNTHETIC_URL,
    });
    expect(typeof attempt.codeDeadline).toBe("string");
    const c = await app.inject({
      method: "POST",
      url: "/api/claude-sign-in/code",
      headers: { cookie },
      payload: { attemptId: attempt.attemptId, code: SYNTHETIC_CODE, name: "work" },
    });
    expect(c.statusCode).toBe(201);
    expect(c.json().credential).toMatchObject({
      name: "work",
      kind: "oauth_token",
      rejected: false,
    });
    expect(Date.parse(c.json().credential.expiresAt) - Date.now()).toBeGreaterThan(YEAR_MS);
    // The settled outcome answers a wait, too.
    const w = await call(h, cookie, "POST", "/api/claude-sign-in/code/wait", {
      attemptId: attempt.attemptId,
    });
    expect(w.statusCode).toBe(201);
    expect(w.json().credential.name).toBe("work");
    const list = await call(h, cookie, "GET", "/api/credentials");
    expect(list.json().credentials.map((x: { name: string }) => x.name)).toEqual(["work"]);
  });

  it("never logs, returns or spawns a secret (AC5)", async () => {
    const lines: string[] = [];
    const h = await setup({ logLevel: "trace", logStream: { write: (l) => void lines.push(l) } });
    const { cookie, spawnCalls } = h;
    const startBodies: string[] = [];
    const otherBodies: string[] = [];
    const start = async () => {
      const r = await call(h, cookie, "POST", "/api/claude-sign-in", {});
      expect(r.statusCode).toBe(200);
      startBodies.push(r.body);
      return r.json().attempt.attemptId as string;
    };
    const other = async (
      ...a: Parameters<typeof call> extends [unknown, unknown, ...infer R] ? R : never
    ) => {
      const r = await call(h, cookie, ...a);
      otherBodies.push(r.body);
      return r;
    };

    startBodies.push((await call(h, cookie, "GET", "/api/claude-sign-in")).body);
    // A code the CLI refuses: the attempt settles with a fixed 422.
    const bad = await start();
    const rejected = await other("POST", "/api/claude-sign-in/code", {
      attemptId: bad,
      code: "bad",
      name: "work",
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toEqual({
      code: "sign_in_code_rejected",
      message: MSG.signInCodeRejected,
    });
    expect(
      (await other("POST", "/api/claude-sign-in/code/wait", { attemptId: bad })).statusCode,
    ).toBe(422);
    // A cancel.
    const cancelled = await start();
    startBodies.push((await call(h, cookie, "GET", "/api/claude-sign-in")).body);
    expect((await other("DELETE", `/api/claude-sign-in/${cancelled}`)).statusCode).toBe(204);
    // Refusals: a bad code shape, a stale id.
    const ok = await start();
    expect(
      (await other("POST", "/api/claude-sign-in/code", { attemptId: ok, code: " ", name: "work" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await other("POST", "/api/claude-sign-in/code", {
          attemptId: cancelled,
          code: SYNTHETIC_CODE,
          name: "work",
        })
      ).statusCode,
    ).toBe(409);
    // The full sign-in.
    const created = await other("POST", "/api/claude-sign-in/code", {
      attemptId: ok,
      code: SYNTHETIC_CODE,
      name: "work",
    });
    expect(created.statusCode).toBe(201);
    expect(
      (await other("POST", "/api/claude-sign-in/code/wait", { attemptId: ok })).statusCode,
    ).toBe(201);
    await other("GET", "/api/credentials");
    // Every line is flushed once the app has closed.
    await h.app.signIn.closeAll();
    await h.app.close();

    const logs = lines.join("\n");
    expect(logs).toContain('"msg":"sign-in started"'); // the capture is live, at trace
    expect(logs).toContain('"msg":"incoming request"');
    for (const secret of [
      SYNTHETIC_URL,
      "SYNTHETICchallenge",
      "SYNTHETICstate",
      SYNTHETIC_CODE,
      SYNTHETIC_TOKEN,
      "sk-ant-oat01",
    ])
      expect(logs).not.toContain(secret);
    expect(startBodies.some((b) => b.includes(SYNTHETIC_URL))).toBe(true);
    for (const body of otherBodies) {
      expect(body).not.toContain(SYNTHETIC_URL);
      expect(body).not.toContain("SYNTHETICchallenge");
    }
    for (const body of [...startBodies, ...otherBodies]) {
      expect(body).not.toContain(SYNTHETIC_TOKEN);
      expect(body).not.toContain("sk-ant-oat01");
      expect(body).not.toContain(SYNTHETIC_CODE);
    }
    expect(spawnCalls.length).toBeGreaterThanOrEqual(3);
    const spawned = JSON.stringify(spawnCalls);
    expect(spawned).not.toContain(SYNTHETIC_CODE);
    expect(spawned).not.toContain(SYNTHETIC_TOKEN);
    expect(spawned).not.toContain(SYNTHETIC_URL);
  });

  it("isolation between users and tabs (AC6)", async () => {
    const h = await setup();
    const a = h.cookie;
    const b = (await signUp(h.app)).cookie;
    const first = (await call(h, a, "POST", "/api/claude-sign-in", {})).json().attempt.attemptId;

    // B sees nothing of A's attempt and can't reach it with A's id.
    expect((await call(h, b, "GET", "/api/claude-sign-in")).json().attempt).toBeNull();
    for (const [method, url, payload] of [
      ["POST", "/api/claude-sign-in/code", { attemptId: first, code: SYNTHETIC_CODE, name: "x" }],
      ["POST", "/api/claude-sign-in/code/wait", { attemptId: first }],
      ["DELETE", `/api/claude-sign-in/${first}`, undefined],
    ] as const) {
      const r = await call(h, b, method, url, payload);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("sign_in_not_found");
    }
    // A's attempt is untouched.
    expect((await call(h, a, "GET", "/api/claude-sign-in")).json().attempt).toMatchObject({
      attemptId: first,
      state: "awaiting_code",
    });

    // A second tab restarts: the first tab's id is stale and touches nothing.
    const second = (await call(h, a, "POST", "/api/claude-sign-in", {})).json().attempt.attemptId;
    expect(second).not.toBe(first);
    for (const [method, url, payload] of [
      ["POST", "/api/claude-sign-in/code", { attemptId: first, code: SYNTHETIC_CODE, name: "x" }],
      ["POST", "/api/claude-sign-in/code/wait", { attemptId: first }],
      ["DELETE", `/api/claude-sign-in/${first}`, undefined],
    ] as const) {
      const r = await call(h, a, method, url, payload);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toEqual({ code: "sign_in_replaced", message: MSG.signInReplaced });
    }
    expect((await call(h, a, "GET", "/api/claude-sign-in")).json().attempt).toMatchObject({
      attemptId: second,
      state: "awaiting_code",
    });

    // B with an attempt of its own and A's id: 409 about B's own attempt.
    const bs = (await call(h, b, "POST", "/api/claude-sign-in", {})).json().attempt.attemptId;
    const r = await call(h, b, "POST", "/api/claude-sign-in/code/wait", { attemptId: second });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("sign_in_replaced");
    // A wait before the code arrived carries the caller's own attempt.
    const early = await call(h, b, "POST", "/api/claude-sign-in/code/wait", { attemptId: bs });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: "sign_in_state", attempt: { attemptId: bs } });
    expect((await call(h, b, "DELETE", `/api/claude-sign-in/${bs}`)).statusCode).toBe(204);
    expect((await call(h, a, "DELETE", `/api/claude-sign-in/${second}`)).statusCode).toBe(204);
  });

  it("a credential named sign-in can still be deleted (D19)", async () => {
    const h = await setup();
    const created = await call(h, h.cookie, "POST", "/api/credentials", {
      name: "sign-in",
      kind: "oauth_token",
      value: "synthetic-value",
    });
    expect(created.statusCode).toBe(201);
    expect((await call(h, h.cookie, "DELETE", "/api/credentials/sign-in")).statusCode).toBe(204);
    expect((await call(h, h.cookie, "GET", "/api/credentials")).json().credentials).toEqual([]);
  });

  it("replace via sign-in keeps the id and assignments (AC8)", async () => {
    const h = await setup();
    const { cookie, t } = h;
    expect(
      (
        await call(h, cookie, "POST", "/api/credentials", {
          name: "work",
          kind: "oauth_token",
          value: "synthetic-old",
        })
      ).statusCode,
    ).toBe(201);
    const [row] = await t.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.name, "work"));
    if (!row) throw new Error("no credential row");
    const agent = await t.seedAgent({ slug: "dev" });
    await t.db
      .update(schema.agents)
      .set({ credentialId: row.id })
      .where(eq(schema.agents.id, agent.id));

    const s = await call(h, cookie, "POST", "/api/claude-sign-in", { replace: "work" });
    expect(s.statusCode).toBe(200);
    const { attempt } = s.json();
    expect(attempt).toMatchObject({ purpose: "replace", name: "work", state: "awaiting_code" });
    // `name` on a replace attempt is ignored.
    const c = await call(h, cookie, "POST", "/api/claude-sign-in/code", {
      attemptId: attempt.attemptId,
      code: SYNTHETIC_CODE,
      name: "ignored",
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().credential).toMatchObject({ name: "work", usedBy: ["dev"], rejected: false });
    expect(Date.parse(c.json().credential.expiresAt) - Date.now()).toBeGreaterThan(YEAR_MS);
    const after = await t.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.name, "work"));
    expect(after.map((r) => r.id)).toEqual([row.id]);
    expect(after[0]?.valueEnc).not.toEqual(row.valueEnc);

    const missing = await call(h, cookie, "POST", "/api/claude-sign-in", { replace: "gone" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({
      code: "credential_not_found",
      message: MSG.credentialDeleted,
    });
  });

  it("replace of an api_key credential is 400 signInOAuthOnly", async () => {
    const h = await setup();
    expect(
      (
        await call(h, h.cookie, "POST", "/api/credentials", {
          name: "key",
          kind: "api_key",
          value: "synthetic-key",
        })
      ).statusCode,
    ).toBe(201);
    const r = await call(h, h.cookie, "POST", "/api/claude-sign-in", { replace: "key" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: "validation_error", message: MSG.signInOAuthOnly });
    expect((await call(h, h.cookie, "GET", "/api/claude-sign-in")).json().attempt).toBeNull();
  });

  it("a paste add ends the user's awaiting_code attempt", async () => {
    const h = await setup();
    const id = (await call(h, h.cookie, "POST", "/api/claude-sign-in", {})).json().attempt
      .attemptId;
    expect(
      (
        await call(h, h.cookie, "POST", "/api/credentials", {
          name: "pasted",
          kind: "oauth_token",
          value: "synthetic-pasted",
        })
      ).statusCode,
    ).toBe(201);
    expect((await call(h, h.cookie, "GET", "/api/claude-sign-in")).json().attempt).toBeNull();
    const r = await call(h, h.cookie, "POST", "/api/claude-sign-in/code", {
      attemptId: id,
      code: SYNTHETIC_CODE,
      name: "work",
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("sign_in_not_found");
  });

  it("name errors keep the attempt and the code unspent", async () => {
    const h = await setup();
    const id = (await call(h, h.cookie, "POST", "/api/claude-sign-in", {})).json().attempt
      .attemptId;
    const bad = await call(h, h.cookie, "POST", "/api/claude-sign-in/code", {
      attemptId: id,
      code: SYNTHETIC_CODE,
      name: "Bad Name",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
    expect(Object.keys(bad.json().error.fields)).toEqual(["name"]);
    expect((await call(h, h.cookie, "GET", "/api/claude-sign-in")).json().attempt.state).toBe(
      "awaiting_code",
    );
    expect((await call(h, h.cookie, "DELETE", `/api/claude-sign-in/${id}`)).statusCode).toBe(204);
  });
});

describe("python3 missing (AC10)", () => {
  it("GET says unavailable, POST is 503 sign_in_unavailable, paste still works", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "of-no-python-"));
    // Every sign-in spawn (the probe and the bridge) sees a PATH with no python3 on it.
    const noPython = ((cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) =>
      spawn(cmd, args, { ...opts, env: { ...opts?.env, PATH: empty } })) as unknown as typeof spawn;
    const h = await setup({ spawnFn: noPython });
    const g = await call(h, h.cookie, "GET", "/api/claude-sign-in");
    expect(g.json()).toEqual({ available: false, attempt: null });
    const s = await call(h, h.cookie, "POST", "/api/claude-sign-in", {});
    expect(s.statusCode).toBe(503);
    expect(s.json().error).toEqual({ code: "sign_in_unavailable", message: MSG.signInUnavailable });
    const paste = await call(h, h.cookie, "POST", "/api/credentials", {
      name: "pasted",
      kind: "oauth_token",
      value: "synthetic-pasted",
    });
    expect(paste.statusCode).toBe(201);
  });
});
