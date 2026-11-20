import { expect, test } from "vitest";
import { createInviteResponseSchema, signUpStateSchema } from "./users.ts";

test("user admin schemas parse", () => {
  expect(
    createInviteResponseSchema.parse({
      invite: { id: "i", createdBy: "@or", createdAt: "a", expiresAt: "b" },
      link: "http://x/sign-up?invite=t",
    }).link,
  ).toContain("invite");
  expect(signUpStateSchema.safeParse({ bootstrap: false, invite: "valid" }).success).toBe(true);
  expect(signUpStateSchema.safeParse({ bootstrap: false, invite: "nope" }).success).toBe(false);
});
