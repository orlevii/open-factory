import type { FactorySettingsDto, ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeDriver } from "../agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "../test/helpers.ts";

/** S10 §8.3, §13: the factory settings REST surface, human session only. */
let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;

beforeEach(async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  or = await signUp(h.app, { handle: "or" });
});
afterEach(() => h.close());

const call = (method: "GET" | "PATCH", payload?: object) =>
  h.app.inject({
    method,
    url: "/api/settings/factory",
    headers: { cookie: or.cookie },
    ...(payload ? { payload } : {}),
  });

test("GET returns the defaults and the env-only local runtime flag", async () => {
  const r = await call("GET");
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({
    warmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 30,
    loopGuardMessages: 10,
    loopGuardWindowMinutes: 10,
    allowLocalRuntime: true,
    defaultImage: h.app.config.defaultImage,
    updatedAt: null,
    updatedBy: null,
  } satisfies FactorySettingsDto);
});

test("PATCH saves, publishes settings_changed and names the editor by handle", async () => {
  const frames: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
  const r = await call("PATCH", { warmWindowMinutes: 120 });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ warmWindowMinutes: 120, updatedBy: "@or" });
  expect(frames).toContainEqual({ type: "settings_changed" });
  expect(h.app.factorySettings.warmWindowMinutes()).toBe(120);
  const got = (await call("GET")).json() as FactorySettingsDto;
  expect(got).toMatchObject({ warmWindowMinutes: 120, updatedBy: "@or" });
  expect(typeof got.updatedAt).toBe("string");
});

test("PATCH of one key keeps the other, and both survive a restart", async () => {
  await call("PATCH", { warmWindowMinutes: 120 });
  await call("PATCH", { memberUpdateDebounceSeconds: 5 });
  const expected = { warmWindowMinutes: 120, memberUpdateDebounceSeconds: 5 };
  expect((await call("GET")).json()).toMatchObject(expected);
  const restarted = await h.reopen();
  expect(restarted.app.factorySettings.get()).toMatchObject(expected);
});

test("a stored row missing a key reads that key's default", async () => {
  await h.sql`update factory_settings set settings = '{"warmWindowMinutes": 90}'::jsonb`;
  const restarted = await h.reopen();
  expect(restarted.app.factorySettings.get()).toMatchObject({
    warmWindowMinutes: 90,
    memberUpdateDebounceSeconds: 30,
  });
});

test("a hand-edited invalid stored key reads its default and the app still boots", async () => {
  await h.sql`update factory_settings set settings = '{"warmWindowMinutes": 0, "memberUpdateDebounceSeconds": 5}'::jsonb`;
  const restarted = await h.reopen();
  expect(restarted.app.factorySettings.get()).toMatchObject({
    warmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 5,
  });
});
test("PATCH is strict: allowLocalRuntime, defaultImage or an unknown key is 400 invalid_settings", async () => {
  for (const body of [{ allowLocalRuntime: false }, { defaultImage: "x:1" }, { nope: 1 }]) {
    const r = await call("PATCH", body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_settings");
  }
  expect(h.app.factorySettings.get().updatedAt).toBeNull();
});

test("PATCH out of bounds is 400 with the field message", async () => {
  const r = await call("PATCH", { warmWindowMinutes: 1441 });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatchObject({
    code: "invalid_settings",
    fields: { warmWindowMinutes: "Enter a whole number from 1 to 1440." },
  });
  expect(h.app.factorySettings.warmWindowMinutes()).toBe(70);
});

test.each([["2"], [null], [2.5]])(
  "PATCH with a wrong-type value (%j) is 400 with the field message",
  async (value) => {
    const r = await call("PATCH", { warmWindowMinutes: value });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "invalid_settings",
      fields: { warmWindowMinutes: "Enter a whole number from 1 to 1440." },
    });
  },
);

test("an empty PATCH returns the settings without writing or publishing", async () => {
  const frames: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
  for (const payload of [{}, undefined]) {
    const r = await call("PATCH", payload);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ warmWindowMinutes: 70, updatedAt: null, updatedBy: null });
  }
  expect(frames).not.toContainEqual({ type: "settings_changed" });
  expect(h.app.factorySettings.get().updatedAt).toBeNull();
});

test.each([
  ["GET", undefined],
  ["PATCH", { warmWindowMinutes: 2 }],
] as const)(
  "%s needs a human session: no auth and a live agent token both get 401",
  async (method, payload) => {
    const url = "/api/settings/factory";
    expect((await h.app.inject({ method, url, ...(payload ? { payload } : {}) })).statusCode).toBe(
      401,
    );
    const lead = await h.seedAgent({ handle: "lead" });
    const { token } = h.app.agentTokens.mint(lead.id);
    const agent = await h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
    expect(agent.statusCode).toBe(401);
  },
);

test("PATCH saves the loop guard limit and window, and the guard reads them on its next check", async () => {
  const r = await call("PATCH", { loopGuardMessages: 4, loopGuardWindowMinutes: 3 });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ loopGuardMessages: 4, loopGuardWindowMinutes: 3 });
  expect(h.app.factorySettings.loopGuardMessages()).toBe(4);
  expect(h.app.factorySettings.loopGuardWindowMs()).toBe(180_000);
  expect((await call("GET")).json()).toMatchObject({
    loopGuardMessages: 4,
    loopGuardWindowMinutes: 3,
  });
});

test.each([
  ["loopGuardMessages", 1, "Enter a whole number from 2 to 1000."],
  ["loopGuardMessages", 1001, "Enter a whole number from 2 to 1000."],
  ["loopGuardWindowMinutes", 0, "Enter a whole number from 1 to 1440."],
  ["loopGuardWindowMinutes", 1441, "Enter a whole number from 1 to 1440."],
])("PATCH %s=%i is 400 with the field message", async (field, value, message) => {
  const r = await call("PATCH", { [field]: value });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatchObject({
    code: "invalid_settings",
    fields: { [field]: message },
  });
  expect(h.app.factorySettings.get().updatedAt).toBeNull();
});
