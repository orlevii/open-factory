import { expect, test } from "vitest";
import { authSecret, deriveKey } from "./keys.ts";

test("subkeys are 32 bytes, stable, and distinct per purpose and root", () => {
  const root = "r".repeat(32);
  const a1 = deriveKey(root, "better-auth");
  expect(a1).toHaveLength(32);
  expect(deriveKey(root, "better-auth").equals(a1)).toBe(true);
  expect(deriveKey(root, "secret-encryption").equals(a1)).toBe(false);
  expect(deriveKey("s".repeat(32), "better-auth").equals(a1)).toBe(false);
  expect(authSecret(root)).toBe(a1.toString("base64url"));
});
