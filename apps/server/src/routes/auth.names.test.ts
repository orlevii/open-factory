import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp, signUp, TEST_ORIGIN } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  h = await makeTestApp();
  await h.seedAgent({ slug: "dev" });
});
afterAll(() => h.close());

const rawSignUp = (handle: string) =>
  h.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: TEST_ORIGIN },
    payload: {
      name: "X",
      handle,
      email: `${handle}-${Date.now()}@example.com`,
      password: "password123",
    },
  });

test("sign-up refuses a handle that is an agent slug", async () => {
  const r = await rawSignUp("dev");
  expect(r.statusCode).toBe(422);
  expect(r.json().code).toBe("HANDLE_TAKEN");
});

test("update-user refuses a handle that is an agent slug, and accepts a free one", async () => {
  const { cookie } = await signUp(h.app, { handle: "or" });
  const taken = await h.app.inject({
    method: "POST",
    url: "/api/auth/update-user",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { handle: "dev" },
  });
  expect(taken.statusCode).toBe(422);
  expect(taken.json().code).toBe("HANDLE_TAKEN");
  const free = await h.app.inject({
    method: "POST",
    url: "/api/auth/update-user",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { handle: "or-two" },
  });
  expect(free.statusCode).toBe(200);
});

test("update-user to one's own current handle is not refused", async () => {
  const { cookie } = await signUp(h.app, { handle: "keeper" });
  const same = await h.app.inject({
    method: "POST",
    url: "/api/auth/update-user",
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { handle: "keeper" },
  });
  expect(same.statusCode).toBe(200);
});

test("system and all are reserved for humans too", async () => {
  expect((await rawSignUp("system")).statusCode).toBe(400);
  expect((await rawSignUp("all")).statusCode).toBe(400);
});
