import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { FakeDriver } from "./testing/fake-driver.ts";
import { insertAgent } from "./testing/rows.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seedAgent();
});
afterAll(() => t.close());

test("get never creates a runtime; bySlug caches one per agent; liveFields has defaults without one", async () => {
  const [row] = await t.sql`select id, status from agents where slug = 'dev'`;
  const id = String(row?.id);
  expect(await t.app.runtimes.get(id)).toBeUndefined();
  expect(await t.app.runtimes.liveFields(id, { status: "hibernated" })).toEqual({
    status: "hibernated",
    turnOpen: false,
    restartPending: false,
    restartWaitingOn: 0,
    waitingOn: { tasks: [], crons: 0 },
  });
  expect((await t.app.runtimes.liveFields(id, { status: "errored" })).status).toBe("errored");
  await t.app.runtimes.refresh(id); // no-op without a runtime
  await t.app.runtimes.requestRestart(id); // likewise
  expect(await t.app.runtimes.get(id)).toBeUndefined();
  const a = await t.app.runtimes.bySlug("dev");
  expect(await t.app.runtimes.bySlug("dev")).toBe(a);
  expect(await t.app.runtimes.get(id)).toBe(a);
  expect(await t.app.runtimes.bySlug("nope")).toBeUndefined();
  await t.sql`update agents set display_name = 'Renamed' where id = ${id}`;
  await t.app.runtimes.refresh(id);
  expect(a?.agent.displayName).toBe("Renamed");
  await t.sql`update agents set display_name = 'Test agent' where id = ${id}`;
});

test("app.close stops running agents gracefully", async () => {
  const u = await t.signUpUser();
  const rt = await t.app.runtimes.bySlug("dev");
  await rt?.sendMessage({
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
  await insertAgent(t.sql, { id: "agent-b", slug: "b" });
  const spy = vi.spyOn(t.app.store, "pendingQueue").mockRejectedValueOnce(new Error("db blip"));
  try {
    await expect(t.app.runtimes.bySlug("b")).rejects.toThrow("db blip");
    const rt = await t.app.runtimes.bySlug("b");
    expect(rt?.agent.slug).toBe("b");
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

test("stopAll still stops healthy runtimes when another init fails", async () => {
  await insertAgent(t.sql, { id: "agent-c", slug: "c" });
  let rejectInit: ((e: Error) => void) | undefined;
  const spy = vi.spyOn(t.app.store, "pendingQueue").mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectInit = reject;
      }),
  );
  try {
    const pendingC = t.app.runtimes.bySlug("c");
    pendingC.catch(() => {});
    await vi.waitFor(() => expect(rejectInit).toBeDefined());
    const u = await t.signUpUser();
    const dev = await t.app.runtimes.bySlug("dev");
    const before = driver.starts.length;
    await dev?.sendMessage({
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
