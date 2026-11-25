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
    warmWindowMinutes: 70,
    memberUpdateDebounceSeconds: 30,
    loopGuardMessages: 10,
    loopGuardWindowMinutes: 10,
    updatedAt: null,
    updatedBy: null,
  });
  expect(s.warmWindowMinutes()).toBe(70);
  expect(s.memberUpdateDebounceMs()).toBe(30_000);
  expect(s.loopGuardMessages()).toBe(10);
  expect(s.loopGuardWindowMs()).toBe(600_000);
});

test("update persists, swaps the copy and tells the listeners", async () => {
  const t = await makeTestApp();
  try {
    const { user } = await t.signUpUser({ handle: "or" });
    const s = await FactorySettings.load(t.db);
    const seen: unknown[] = [];
    s.onChange((prev, next) => seen.push({ prev, next }));
    await s.update({ memberUpdateDebounceSeconds: 0 }, user.id);
    expect(s.memberUpdateDebounceMs()).toBe(0);
    expect(s.warmWindowMinutes()).toBe(70);
    expect(s.get()).toMatchObject({ updatedBy: user.id });
    expect(s.get().updatedAt).toBeInstanceOf(Date);
    expect(seen).toEqual([
      {
        prev: {
          warmWindowMinutes: 70,
          memberUpdateDebounceSeconds: 30,
          loopGuardMessages: 10,
          loopGuardWindowMinutes: 10,
        },
        next: {
          warmWindowMinutes: 70,
          memberUpdateDebounceSeconds: 0,
          loopGuardMessages: 10,
          loopGuardWindowMinutes: 10,
        },
      },
    ]);
    const reloaded = await FactorySettings.load(t.db);
    expect(reloaded.get()).toMatchObject({
      memberUpdateDebounceSeconds: 0,
      updatedBy: user.id,
    });
  } finally {
    await t.close();
  }
});

test("a listener that throws is logged; the update still completes and later listeners still run", async () => {
  const t = await makeTestApp();
  try {
    const { user } = await t.signUpUser({ handle: "or" });
    const errors: unknown[] = [];
    const s = await FactorySettings.load(t.db, { error: (obj) => errors.push(obj) });
    const boom = new Error("boom");
    const seen: number[] = [];
    s.onChange(() => {
      throw boom;
    });
    s.onChange((_prev, next) => seen.push(next.warmWindowMinutes));
    await s.update({ warmWindowMinutes: 3 }, user.id);
    expect(s.warmWindowMinutes()).toBe(3);
    expect(seen).toEqual([3]);
    expect(errors).toEqual([{ err: boom }]);
  } finally {
    await t.close();
  }
});
