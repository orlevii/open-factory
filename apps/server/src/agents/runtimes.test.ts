import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { FakeDriver } from "./testing/fake-driver.ts";

let t: Awaited<ReturnType<typeof makeTestApp>>;
const driver = new FakeDriver();
beforeAll(async () => {
  t = await makeTestApp({ harnessDriver: driver });
  await t.seed();
});
afterAll(() => t.close());

test("list shows the seeded agent as hibernated; bySlug caches one runtime per agent", async () => {
  expect(await t.app.runtimes.list()).toEqual([
    {
      slug: "dev",
      displayName: "Dev agent",
      description: expect.any(String),
      status: "hibernated",
      turnOpen: false,
      runtime: "local",
    },
  ]);
  const a = await t.app.runtimes.bySlug("dev");
  expect(await t.app.runtimes.bySlug("dev")).toBe(a);
  expect(await t.app.runtimes.bySlug("nope")).toBeUndefined();
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
  await t.app.runtimes.stopAll();
  expect(rt?.summary().status).toBe("hibernated");
});

test("a rejected init is evicted, so the next lookup retries", async () => {
  await t.sql`insert into agents (id, slug, display_name) values ('agent-b', 'b', 'B')`;
  const spy = vi.spyOn(t.app.store, "pendingQueue").mockRejectedValueOnce(new Error("db blip"));
  try {
    await expect(t.app.runtimes.bySlug("b")).rejects.toThrow("db blip");
    const rt = await t.app.runtimes.bySlug("b");
    expect(rt?.summary().slug).toBe("b");
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

test("stopAll still stops healthy runtimes when another init fails", async () => {
  await t.sql`insert into agents (id, slug, display_name) values ('agent-c', 'c', 'C')`;
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
    expect(dev?.summary().status).not.toBe("hibernated");
    const stopping = t.app.runtimes.stopAll();
    rejectInit?.(new Error("db blip"));
    await expect(stopping).resolves.toBeUndefined();
    expect(dev?.summary().status).toBe("hibernated");
  } finally {
    spy.mockRestore();
  }
});
