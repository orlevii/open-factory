import { afterAll, beforeAll, expect, test } from "vitest";
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
