import { afterEach, beforeEach, expect, test } from "vitest";
import { createTestDb, makeTestApp } from "../test/helpers.ts";
import { FactorySettings } from "./factory-settings.ts";

/** S10 §8.1, §8.2: the single settings row, loaded at boot and swapped on update. */
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.close());

test("load reads the seeded row", async () => {
  const s = await FactorySettings.load(db.db);
  expect(s.get()).toEqual({
    maxRunningAgents: 8,
    defaultWarmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 30,
    updatedAt: null,
    updatedBy: null,
  });
  expect(s.maxRunningAgents()).toBe(8);
  expect(s.defaultWarmWindowMinutes()).toBe(70);
  expect(s.memberUpdateDebounceMs()).toBe(30_000);
});

test("update persists, swaps the copy and tells the listeners", async () => {
  const t = await makeTestApp();
  try {
    const { user } = await t.signUpUser({ handle: "or" });
    const s = await FactorySettings.load(t.db);
    const seen: unknown[] = [];
    s.onChange((prev, next) => seen.push({ prev, next }));
    await s.update({ maxRunningAgents: 2, memberUpdateDebounceSeconds: 0 }, user.id);
    expect(s.maxRunningAgents()).toBe(2);
    expect(s.memberUpdateDebounceMs()).toBe(0);
    expect(s.defaultWarmWindowMinutes()).toBe(70);
    expect(s.get()).toMatchObject({ updatedBy: user.id });
    expect(s.get().updatedAt).toBeInstanceOf(Date);
    expect(seen).toEqual([
      {
        prev: {
          maxRunningAgents: 8,
          defaultWarmWindowMinutes: 70,
          memberUpdateDebounceSeconds: 30,
        },
        next: { maxRunningAgents: 2, defaultWarmWindowMinutes: 70, memberUpdateDebounceSeconds: 0 },
      },
    ]);
    const reloaded = await FactorySettings.load(t.db);
    expect(reloaded.get()).toMatchObject({
      maxRunningAgents: 2,
      memberUpdateDebounceSeconds: 0,
      updatedBy: user.id,
    });
  } finally {
    await t.close();
  }
});
