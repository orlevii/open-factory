import { expect, test } from "vitest";
import { KeyLock } from "./key-lock.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("tasks on one key run strictly in call order, never overlapping", async () => {
  const lock = new KeyLock();
  const log: string[] = [];
  const task = (id: string, ms: number) => async () => {
    log.push(`start ${id}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${id}`);
    return id;
  };
  const out = await Promise.all([
    lock.run("a", task("slow", 30)),
    lock.run("a", task("fast", 1)),
    lock.run("a", task("last", 1)),
  ]);
  expect(out).toEqual(["slow", "fast", "last"]);
  expect(log).toEqual([
    "start slow",
    "end slow",
    "start fast",
    "end fast",
    "start last",
    "end last",
  ]);
});

test("different keys overlap", async () => {
  const lock = new KeyLock();
  let running = 0;
  let peak = 0;
  const task = async () => {
    peak = Math.max(peak, ++running);
    await tick();
    running--;
  };
  await Promise.all([lock.run("a", task), lock.run("b", task)]);
  expect(peak).toBe(2);
});

test("a failing task rejects its caller and does not block the next", async () => {
  const lock = new KeyLock();
  const bad = lock.run("a", async () => {
    throw new Error("x");
  });
  const good = lock.run("a", async () => "ok");
  await expect(bad).rejects.toThrow("x");
  await expect(good).resolves.toBe("ok");
});
