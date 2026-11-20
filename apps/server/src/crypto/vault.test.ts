import { expect, test } from "vitest";
import { Vault, VaultError } from "./vault.ts";

const v = new Vault("k".repeat(40));
test("round trip, version byte and random nonce", () => {
  const a = v.seal("sk-ant-oat01-secret", "credentials:c1");
  const b = v.seal("sk-ant-oat01-secret", "credentials:c1");
  expect(a[0]).toBe(1);
  expect(a.equals(b)).toBe(false);
  expect(v.open(a, "credentials:c1")).toBe("sk-ant-oat01-secret");
  expect(a.includes(Buffer.from("sk-ant"))).toBe(false);
});
test("wrong AAD, tampering, wrong key, unknown version fail", () => {
  const a = v.seal("x", "secrets:s1");
  expect(() => v.open(a, "secrets:s2")).toThrow(VaultError);
  const t = Buffer.from(a);
  t.writeUInt8(t.readUInt8(t.length - 1) ^ 1, t.length - 1);
  expect(() => v.open(t, "secrets:s1")).toThrow(VaultError);
  expect(() => new Vault("z".repeat(40)).open(a, "secrets:s1")).toThrow(VaultError);
  const w = Buffer.from(a);
  w[0] = 2;
  expect(() => v.open(w, "secrets:s1")).toThrow(VaultError);
});
