import { describe, expect, it } from "vitest";
import { attemptViewSchema, normalizeSignInCode, submitCodeBodySchema } from "./claude-sign-in.ts";
import { MSG } from "./messages.ts";
import { INBOX_KINDS, inboxItemSchema } from "./messaging.ts";

describe("normalizeSignInCode", () => {
  it("removes every whitespace character", () => {
    expect(normalizeSignInCode("  abc\n#def\t ")).toBe("abc#def");
  });
  it.each(["", "   ", "a".repeat(513), "ab\u0007c", "abé"])("refuses %j", (c) => {
    expect(normalizeSignInCode(c)).toBeUndefined();
  });
  it("accepts 512 printable characters", () => {
    expect(normalizeSignInCode("x".repeat(512))).toBe("x".repeat(512));
  });
});

describe("schemas", () => {
  it("attempt view carries no token field and only known states", () => {
    const v = {
      attemptId: "a1",
      state: "awaiting_code",
      url: "https://claude.com/x",
      codeDeadline: "2026-11-23T10:00:00.000Z",
      purpose: "create",
    };
    expect(attemptViewSchema.parse(v)).toEqual(v);
    expect(attemptViewSchema.safeParse({ ...v, state: "minted" }).success).toBe(false);
    expect(attemptViewSchema.safeParse({ ...v, token: "x" }).success).toBe(false);
  });
  it("submit body requires attemptId and code", () => {
    expect(submitCodeBodySchema.safeParse({ code: "x" }).success).toBe(false);
    expect(
      submitCodeBodySchema.safeParse({ attemptId: "a", code: "x", name: "work" }).success,
    ).toBe(true);
  });
  it("inbox has the credential kind and link", () => {
    expect(INBOX_KINDS).toContain("credential");
    const item = inboxItemSchema.parse({
      id: "i",
      messageId: "m",
      kind: "credential",
      read: false,
      from: { kind: "factory", name: "factory" },
      to: "everyone",
      preview: "work expires on 2027-11-12.",
      urgent: false,
      createdAt: "2026-11-23T10:00:00.000Z",
      credential: { name: "work", expiresAt: "2027-11-12T10:00:00.000Z", current: true },
      link: { kind: "credential", name: "work" },
    });
    expect(item.link).toEqual({ kind: "credential", name: "work" });
  });
});

describe("sign-in messages", () => {
  it.each(Object.entries(MSG).filter(([k]) => k.startsWith("signIn")))("%s ≤ 40 chars", (_k, v) => {
    expect(v.length).toBeLessThanOrEqual(40);
  });
});
