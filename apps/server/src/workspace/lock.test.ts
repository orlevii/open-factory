import { expect, test } from "vitest";
import { KeyedMutex } from "./lock.ts";

test("serializes per key, not across keys, and releases on error", async () => {
  const m = new KeyedMutex();
  const order: string[] = [];
  const slow = m.run("a", async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("a1");
  });
  const fast = m.run("a", async () => {
    order.push("a2");
  });
  const other = m.run("b", async () => {
    order.push("b1");
  });
  await Promise.all([slow, fast, other]);
  expect(order).toEqual(["b1", "a1", "a2"]);
  await expect(
    m.run("a", async () => {
      throw new Error("x");
    }),
  ).rejects.toThrow("x");
  expect(await m.run("a", async () => 1)).toBe(1);
});
