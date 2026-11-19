import { afterAll, beforeAll, expect, test } from "vitest";
import { ev, FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp } from "../test/helpers.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
const driver = new FakeDriver();
const TOKEN = "sk-ant-oat01-ROUTE-SECRET";

/** Answers each verification process as it starts. */
let answer: "ok" | "401" = "ok";
const watcher = setInterval(() => {
  for (const p of driver.starts) {
    if ((p as unknown as { answered?: boolean }).answered) continue;
    (p as unknown as { answered?: boolean }).answered = true;
    p.emit(
      ev.session(),
      ev.turn(),
      answer === "ok" ? ev.end() : ev.end({ isError: true, apiErrorStatus: 401 }),
    );
  }
}, 5);

beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(async () => {
  clearInterval(watcher);
  await t.close();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

test("every route requires a signed-in user", async () => {
  for (const [method, url] of [
    ["GET", "/api/credentials"],
    ["POST", "/api/credentials"],
    ["PUT", "/api/credentials/x/value"],
    ["POST", "/api/credentials/x/verify"],
    ["DELETE", "/api/credentials/x"],
  ] as const)
    expect((await t.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
});

test("create, list, replace, verify, delete; the value never comes back", async () => {
  const created = await call("POST", "/api/credentials", {
    name: "work",
    kind: "oauth_token",
    value: TOKEN,
  });
  expect(created.statusCode).toBe(201);
  expect(created.body).not.toContain(TOKEN);
  expect(created.json().credential).toMatchObject({
    name: "work",
    kind: "oauth_token",
    usedBy: [],
  });

  const list = await call("GET", "/api/credentials");
  expect(list.json().credentials.map((c: { name: string }) => c.name)).toEqual(["work"]);
  expect(list.body).not.toContain(TOKEN);

  expect((await call("PUT", "/api/credentials/work/value", { value: "other" })).statusCode).toBe(
    200,
  );
  expect(
    (await call("POST", "/api/credentials/work/verify")).json().credential.lastError,
  ).toBeNull();

  expect((await call("DELETE", "/api/credentials/work")).statusCode).toBe(204);
  expect((await call("GET", "/api/credentials")).json().credentials).toEqual([]);
});

test("validation, duplicate and rejected errors", async () => {
  expect(
    (await call("POST", "/api/credentials", { name: "Bad Name", kind: "oauth_token", value: "x" }))
      .statusCode,
  ).toBe(400);
  expect(
    (await call("POST", "/api/credentials", { name: "ok", kind: "oauth_token", value: "" }))
      .statusCode,
  ).toBe(400);
  await call("POST", "/api/credentials", { name: "dup", kind: "api_key", value: "k" });
  const dup = await call("POST", "/api/credentials", { name: "dup", kind: "api_key", value: "k" });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().error.code).toBe("credential_exists");
  answer = "401";
  const bad = await call("POST", "/api/credentials", { name: "nope", kind: "api_key", value: "k" });
  expect(bad.statusCode).toBe(422);
  expect(bad.json().error).toMatchObject({
    code: "credential_rejected",
    message: "Claude rejected this API key.",
  });
  answer = "ok";
  expect((await call("DELETE", "/api/credentials/ghost")).statusCode).toBe(404);
});
