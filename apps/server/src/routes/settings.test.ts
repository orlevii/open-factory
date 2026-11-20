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
    maxRunningAgents: 8,
    defaultWarmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 30,
    allowLocalRuntime: true,
    updatedAt: null,
    updatedBy: null,
  } satisfies FactorySettingsDto);
});

test("PATCH saves, publishes settings_changed and names the editor by handle", async () => {
  const frames: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
  const r = await call("PATCH", { maxRunningAgents: 2 });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ maxRunningAgents: 2, updatedBy: "@or" });
  expect(frames).toContainEqual({ type: "settings_changed" });
  expect(h.app.factorySettings.maxRunningAgents()).toBe(2);
  const got = (await call("GET")).json() as FactorySettingsDto;
  expect(got).toMatchObject({
    maxRunningAgents: 2,
    defaultWarmWindowMinutes: 70,
    updatedBy: "@or",
  });
  expect(typeof got.updatedAt).toBe("string");
});

test("PATCH is strict: allowLocalRuntime or an unknown key is 400 invalid_settings", async () => {
  for (const body of [{ allowLocalRuntime: false }, { nope: 1 }]) {
    const r = await call("PATCH", body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_settings");
  }
  expect(h.app.factorySettings.get().updatedAt).toBeNull();
});

test("PATCH out of bounds is 400 with the field message", async () => {
  const r = await call("PATCH", { maxRunningAgents: 65 });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toMatchObject({
    code: "invalid_settings",
    fields: { maxRunningAgents: "Enter a whole number from 1 to 64." },
  });
  expect(h.app.factorySettings.maxRunningAgents()).toBe(8);
});

test.each([["2"], [null], [2.5]])(
  "PATCH with a wrong-type value (%j) is 400 with the field message",
  async (value) => {
    const r = await call("PATCH", { maxRunningAgents: value });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: "invalid_settings",
      fields: { maxRunningAgents: "Enter a whole number from 1 to 64." },
    });
  },
);

test("an empty PATCH returns the settings without writing or publishing", async () => {
  const frames: ServerMessage[] = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
  for (const payload of [{}, undefined]) {
    const r = await call("PATCH", payload);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ maxRunningAgents: 8, updatedAt: null, updatedBy: null });
  }
  expect(frames).not.toContainEqual({ type: "settings_changed" });
  expect(h.app.factorySettings.get().updatedAt).toBeNull();
});

test.each([
  ["GET", undefined],
  ["PATCH", { maxRunningAgents: 2 }],
] as const)(
  "%s needs a human session: no auth and a live agent token both get 401",
  async (method, payload) => {
    const url = "/api/settings/factory";
    expect((await h.app.inject({ method, url, ...(payload ? { payload } : {}) })).statusCode).toBe(
      401,
    );
    const lead = await h.seedAgent({ slug: "lead" });
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
