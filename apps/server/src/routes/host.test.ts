import os from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => {
  h = await makeTestApp();
});
afterEach(() => h.close());

test("401 without a session", async () => {
  expect((await h.app.inject({ method: "GET", url: "/api/host" })).statusCode).toBe(401);
});

test("the factory machine's platform, hostname and home", async () => {
  const or = await signUp(h.app, { handle: "or" });
  const res = await h.app.inject({
    method: "GET",
    url: "/api/host",
    headers: { cookie: or.cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    platform: process.platform,
    hostname: os.hostname(),
    home: os.homedir(),
  });
});
