import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { signUp, TEST_ORIGIN } from "../test/helpers.ts";
import { appWithFakeClaude } from "../test/sign-in-helpers.ts";

// Spec §5.4 (attempts end without a request), AC4. The fake CLI only.
const hasPython = spawnSync("python3", ["--version"]).status === 0;
if (!hasPython && process.env.CI)
  throw new Error("python3 is required for the sign-in route tests");

type Harness = Awaited<ReturnType<typeof appWithFakeClaude>>;

async function setup(): Promise<Harness> {
  const h = await appWithFakeClaude();
  onTestFinished(async () => {
    await h.app.signIn.closeAll();
    await h.t.close();
  });
  return h;
}

const get = (h: Harness, cookie: string) =>
  h.app.inject({ method: "GET", url: "/api/claude-sign-in", headers: { cookie } });

async function start(h: Harness, cookie: string): Promise<number> {
  const r = await h.app.inject({
    method: "POST",
    url: "/api/claude-sign-in",
    headers: { cookie },
    payload: {},
  });
  expect(r.statusCode).toBe(200);
  return Number(await readFile(path.join(h.fake.dir, "setup-token.pid"), "utf8"));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
};

/** The kill path escalates over 3 s; poll up to 5 s. */
async function gone(pid: number) {
  const until = Date.now() + 5000;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  expect(alive(pid)).toBe(false);
}

describe.skipIf(!hasPython)("sign-in attempts end without a request (fake CLI)", () => {
  it("sign-out ends the user's attempt and its process", async () => {
    const h = await setup();
    const pid = await start(h, h.cookie);
    const out = await h.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: h.cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    const other = await signUp(h.app, { handle: "al" });
    expect((await get(h, other.cookie)).json().attempt).toBeNull();
    await gone(pid);
  });

  it("a failing session lookup never fails the sign-out", async () => {
    const h = await setup();
    vi.spyOn(h.app.auth.api, "getSession").mockRejectedValueOnce(new Error("db down"));
    const out = await h.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: h.cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
  });

  it("a sign-out without a session leaves the attempt alone", async () => {
    const h = await setup();
    const pid = await start(h, h.cookie);
    await h.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: {},
    });
    expect((await get(h, h.cookie)).json().attempt).not.toBeNull();
    expect(alive(pid)).toBe(true);
  });

  it("disabling a user ends their attempt", async () => {
    const h = await setup();
    const al = await signUp(h.app, { handle: "al" });
    const pid = await start(h, al.cookie);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/users/${al.user.id}/disable`,
      headers: { cookie: h.cookie, origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    await gone(pid);
  });

  it("closing the app ends every attempt", async () => {
    const h = await setup();
    const al = await signUp(h.app, { handle: "al" });
    const pid = await start(h, h.cookie);
    // Both share the fake dir; the pid is read right after each start, before the next overwrites it.
    const pid2 = await start(h, al.cookie);
    await h.app.close();
    await gone(pid);
    await gone(pid2);
  });
});
