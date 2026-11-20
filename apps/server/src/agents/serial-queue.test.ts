import { expect, test } from "vitest";
import { SerialQueue } from "./serial-queue.ts";

test("runs jobs one at a time, in order, and survives a failing job", async () => {
  const q = new SerialQueue();
  const order: string[] = [];
  const slow = q.run(async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push("a");
  });
  const failing = q.run(async () => {
    order.push("b");
    throw new Error("x");
  });
  const fast = q.run(async () => {
    order.push("c");
    return 3;
  });
  await slow;
  await expect(failing).rejects.toThrow("x");
  expect(await fast).toBe(3);
  await q.idle();
  expect(order).toEqual(["a", "b", "c"]);
});
