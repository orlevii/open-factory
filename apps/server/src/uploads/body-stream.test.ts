import { expect, test } from "vitest";
import { bodyStream, UploadIdleError } from "./body-stream.ts";

test("chunks pass through; a chunk that doesn't arrive within the idle time throws UploadIdleError", async () => {
  async function* src() {
    yield Buffer.from("a");
    yield Buffer.from("b");
    await new Promise(() => {}); // stalls forever
  }
  const got: string[] = [];
  const err = await (async () => {
    for await (const c of bodyStream(src(), 30)) got.push(c.toString());
  })().catch((e) => e);
  expect(got).toEqual(["a", "b"]);
  expect(err).toBeInstanceOf(UploadIdleError);
});

test("an early exit never calls return() on the request (it would destroy it)", async () => {
  let returned = false;
  const raw: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: Buffer.from("x"), done: false }),
        return: async () => {
          returned = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
  for await (const _ of bodyStream(raw, 1000)) break;
  expect(returned).toBe(false);
});
