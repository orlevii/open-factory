import { expect, test } from "vitest";
import { escapeLike } from "./like.ts";

test("escapeLike escapes %, _ and the escape character", () => {
  expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  expect(escapeLike("plain")).toBe("plain");
});
