import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp, runtimeOf } from "../test/helpers.ts";
import { FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";
import { sendAs } from "./testing/runtime-harness.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seedAgent();
});
afterAll(() => t.close());

test("get never creates a runtime; byRef caches one per agent; liveFields has defaults without one", async () => {
  const [row] =
    await t.sql`select id, status from agents where id = (select id from principals where handle = 'dev')`;
  const id = String(row?.id);
  expect(await t.app.runtimes.get(id)).toBeUndefined();
  expect(await t.app.runtimes.liveFields(id, { status: "hibernated" })).toEqual({
    status: "hibernated",
    turnOpen: false,
    restartPending: false,
    restartWaitingOn: 0,
    restartChanges: [],
    waitingOn: { tasks: [], crons: 0 },
    crons: [],
    cronZone: expect.any(String),
    stopCronsPending: false,
  });
  expect((await t.app.runtimes.liveFields(id, { status: "errored" })).status).toBe("errored");
  await t.app.runtimes.refresh(id); // no-op without a runtime
  await t.app.runtimes.requestRestart(id); // likewise
  expect(await t.app.runtimes.get(id)).toBeUndefined();
  const a = await runtimeOf(t.app, "dev");
  expect(await runtimeOf(t.app, "dev")).toBe(a);
  expect(await t.app.runtimes.get(id)).toBe(a);
  expect(await runtimeOf(t.app, "nope")).toBeUndefined();
  await t.sql`update agents set display_name = 'Renamed' where id = ${id}`;
  await t.app.runtimes.refresh(id);
  expect(a?.agent.displayName).toBe("Renamed");
  await t.sql`update agents set display_name = 'Test agent' where id = ${id}`;
});

test("the first GET /api/agents after boot carries runtimeDisabled for a local agent no runtime has loaded (spec §8.2)", async () => {
  await t.seedAgent({ handle: "gated" });
  const { cookie } = await t.signUpUser({ handle: "gate" });
  const [row] =
    await t.sql`select id from agents where id = (select id from principals where handle = 'gated')`;
  const config = t.app.config as { allowLocalRuntime: boolean };
  const list = async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/agents", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    return (r.json() as { agents: { handle: string; runtimeDisabled?: string }[] }).agents.find(
      (a) => a.handle === "gated",
    );
  };
  config.allowLocalRuntime = false;
  try {
    expect(await t.app.runtimes.get(String(row?.id))).toBeUndefined();
    expect((await list())?.runtimeDisabled).toBe("The local runtime is disabled on this factory.");
  } finally {
    config.allowLocalRuntime = true;
  }
  expect((await list())?.runtimeDisabled).toBeUndefined();
  expect(await t.app.runtimes.get(String(row?.id))).toBeUndefined(); // listing never loads one
});

test("app.close stops running agents gracefully", async () => {
  const u = await t.signUpUser();
  const rt = await runtimeOf(t.app, "dev");
  await sendAs(t.app.store, rt, {
    fromUserId: u.user.id,
    fromHandle: u.user.handle,
    body: "hi",
    urgent: false,
  });
  expect(driver.starts).toHaveLength(1);
  // the first batch is in flight, so the restart waits; stopAll clears it
  await t.app.runtimes.requestRestart(String(rt?.agent.id));
  expect(rt?.live().restartPending).toBe(true);
  await t.app.runtimes.stopAll();
  expect(rt?.live()).toMatchObject({ status: "hibernated", restartPending: false });
  expect(driver.starts).toHaveLength(1);
});

test("a rejected init is evicted, so the next lookup retries", async () => {
  await insertAgent(t.sql, { id: "agent-b", handle: "b" });
  const spy = vi.spyOn(t.app.store, "pendingQueue").mockRejectedValueOnce(new Error("db blip"));
  try {
    await expect(runtimeOf(t.app, "b")).rejects.toThrow("db blip");
    const rt = await runtimeOf(t.app, "b");
    expect(rt?.agent.handle).toBe("b");
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

test("stopAll still stops healthy runtimes when another init fails", async () => {
  await insertAgent(t.sql, { id: "agent-c", handle: "c" });
  let rejectInit: ((e: Error) => void) | undefined;
  const spy = vi.spyOn(t.app.store, "pendingQueue").mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectInit = reject;
      }),
  );
  try {
    const pendingC = runtimeOf(t.app, "c");
    pendingC.catch(() => {});
    await vi.waitFor(() => expect(rejectInit).toBeDefined());
    const u = await t.signUpUser();
    const dev = await runtimeOf(t.app, "dev");
    const before = driver.starts.length;
    await sendAs(t.app.store, dev, {
      fromUserId: u.user.id,
      fromHandle: u.user.handle,
      body: "again",
      urgent: false,
    });
    expect(driver.starts.length).toBe(before + 1);
    expect(dev?.live().status).not.toBe("hibernated");
    const stopping = t.app.runtimes.stopAll();
    rejectInit?.(new Error("db blip"));
    await expect(stopping).resolves.toBeUndefined();
    expect(dev?.live().status).toBe("hibernated");
  } finally {
    spy.mockRestore();
  }
});
