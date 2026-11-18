import { expect, test } from "vitest";
import { AsyncQueue } from "./async-queue.ts";

test("yields pushed values in order and finishes after end()", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  setTimeout(() => {
    q.push(2);
    q.end();
  }, 5);
  const out: number[] = [];
  for await (const v of q) out.push(v);
  expect(out).toEqual([1, 2]);
});

test("push after end is ignored", async () => {
  const q = new AsyncQueue<number>();
  q.end();
  q.push(1);
  const out: number[] = [];
  for await (const v of q) out.push(v);
  expect(out).toEqual([]);
});
