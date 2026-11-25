import { expect, test } from "vitest";
import { signUpStateSchema } from "./users.ts";

test("a sign-up state with an unknown invite status is refused", () => {
  expect(signUpStateSchema.safeParse({ bootstrap: false, invite: "nope" }).success).toBe(false);
});
