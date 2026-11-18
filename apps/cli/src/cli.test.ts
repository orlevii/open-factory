import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp, signUp } from "../../server/src/test/helpers.ts";
import { run } from "./commands.ts";
import { readConfig, writeConfig } from "./config-store.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let url: string;
let creds: { email: string; password: string; handle: string };
beforeAll(async () => {
  t = await makeTestApp();
  const s = await signUp(t.app, { handle: "cli-user" });
  creds = { email: s.input.email, password: s.input.password, handle: "cli-user" };
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await t.close();
});

function io(answers: string[] = [], extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), "of-cli-")), ...extraEnv };
  return {
    out,
    err,
    env,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      ask: async (_q: string, def?: string) => answers.shift() || def || "",
      askHidden: async () => answers.shift() ?? "",
      env,
      fetch,
    },
  };
}

test("status before login: server version, not logged in, exit 0", async () => {
  const h = io([], { OPEN_FACTORY_URL: url });
  expect(await run(["status"], h.io)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toMatch(/^Server version: 0\.1\.0$/m);
  expect(text).toMatch(/^Database: ok$/m);
  expect(text).toMatch(/^CLI version: 0\.1\.0$/m);
  expect(text).toMatch(/^Not logged in$/m);
});

test("login -> status -> logout", async () => {
  const h = io([creds.email, creds.password]);
  expect(await run(["login", "--url", url], h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("Logged in as @cli-user");
  const cfg = await readConfig(h.env);
  expect(cfg.url).toBe(url);
  expect(cfg.token).toBeTruthy();

  h.out.length = 0;
  expect(await run(["status"], h.io)).toBe(0);
  expect(h.out.join("\n")).toMatch(/^Logged in as @cli-user$/m);

  expect(await run(["logout"], h.io)).toBe(0);
  expect((await readConfig(h.env)).token).toBeUndefined();
  const me = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${cfg.token}` } });
  expect(me.status).toBe(401); // server session revoked
});

test("login with a wrong password fails with exit 1", async () => {
  const h = io([creds.email, "wrong-password"]);
  expect(await run(["login", "--url", url], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Wrong email or password|INVALID_EMAIL_OR_PASSWORD/);
});

// better-auth skips its origin/CSRF checks under NODE_ENV=test, so the real-server tests above
// can't catch this: Node's fetch always sends `sec-fetch-mode: cors`, which makes a production
// server demand a trusted Origin on sign-in ("Missing or null Origin").
test("login sends the server's own origin on sign-in", async () => {
  let origin: string | null = "unset";
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/auth/sign-in/email")) {
      origin = new Headers(init?.headers).get("origin");
      return Response.json({ code: "INVALID_ORIGIN", message: "Invalid origin" }, { status: 403 });
    }
    throw new Error(`unexpected request ${String(input)}`);
  };
  const h = io([creds.email, creds.password]);
  expect(
    await run(["login", "--url", "http://example.test:4000/"], { ...h.io, fetch: fakeFetch }),
  ).toBe(1);
  expect(origin).toBe("http://example.test:4000");
  expect(h.err.join("\n")).toMatch(/PUBLIC_URL/);
});

test("unreachable server: status exits 1 with a plain message; logout still clears the token", async () => {
  const h = io([], { OPEN_FACTORY_URL: "http://127.0.0.1:1" });
  expect(await run(["status"], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Cannot reach server at http:\/\/127\.0\.0\.1:1/);
  await writeConfig(h.env, { url: "http://127.0.0.1:1", token: "stored-token" });
  h.err.length = 0;
  expect(await run(["logout"], h.io)).toBe(0);
  expect(h.err.join("\n")).toMatch(/removed the local token anyway/);
  expect(h.out).toContain("Logged out");
  expect(await readConfig(h.env)).toEqual({ url: "http://127.0.0.1:1" });
});

test("OPEN_FACTORY_TOKEN drives status; a stale token reads as not logged in", async () => {
  const s = await signUp(t.app);
  const ok = io([], { OPEN_FACTORY_URL: url, OPEN_FACTORY_TOKEN: s.token });
  expect(await run(["status"], ok.io)).toBe(0);
  expect(ok.out.join("\n")).toMatch(new RegExp(`^Logged in as @${s.user.handle}$`, "m"));

  const stale = io([], { OPEN_FACTORY_URL: url, OPEN_FACTORY_TOKEN: "stale-or-revoked" });
  expect(await run(["status"], stale.io)).toBe(0);
  expect(stale.out.join("\n")).toMatch(/^Not logged in$/m);
});

test("login rejects a URL without an http(s) scheme before prompting", async () => {
  for (const bad of ["localhost:3000", "ftp://h", "not a url"]) {
    const h = io([creds.email, creds.password]);
    const calls: string[] = [];
    const spy: typeof fetch = async (input) => {
      calls.push(String(input));
      throw new Error("must not be called");
    };
    expect(await run(["login", "--url", bad], { ...h.io, fetch: spy })).toBe(1);
    expect(h.err.join("\n")).toMatch(/Invalid server URL.*http:\/\/ or https:\/\//);
    expect(calls).toEqual([]);
  }
  // Also when typed at the prompt.
  const h = io(["localhost:3000"]);
  expect(await run(["login"], h.io)).toBe(1);
  expect(h.err.join("\n")).toMatch(/Invalid server URL "localhost:3000"/);
});

test("help and --version", async () => {
  const h = io();
  expect(await run([], h.io)).toBe(0);
  expect(h.out.join("\n")).toMatch(/login[\s\S]*logout[\s\S]*status/);
  h.out.length = 0;
  expect(await run(["--version"], h.io)).toBe(0);
  expect(h.out).toEqual(["0.1.0"]);
  expect(await run(["nope"], h.io)).toBe(1);
});
