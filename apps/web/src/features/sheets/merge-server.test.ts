import { expect, test } from "vitest";
import { mergeServer } from "./merge-server";

const base = { a: "1", b: "2", c: "3" };

test("an untouched field follows the server", () => {
  expect(mergeServer(base, base, { ...base, b: "S" })).toEqual({ a: "1", b: "S", c: "3" });
});

test("a touched field keeps the user's value", () => {
  expect(mergeServer({ ...base, a: "mine" }, base, { ...base, a: "S", c: "S" })).toEqual({
    a: "mine",
    b: "2",
    c: "S",
  });
});

test("does not mutate its inputs", () => {
  const prev = { ...base };
  mergeServer(prev, base, { ...base, a: "S" });
  expect(prev).toEqual(base);
});
