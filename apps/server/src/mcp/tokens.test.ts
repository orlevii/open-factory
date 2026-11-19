import { expect, test } from "vitest";
import { AgentTokens } from "./tokens.ts";

test("a token belongs to one process; revoked tokens fail even when a newer one exists", () => {
  const t = new AgentTokens();
  const a = t.mint("ag1");
  expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(t.verify(a.token)).toEqual({ agentId: "ag1", generation: a.generation });
  const b = t.mint("ag1");
  t.revoke("ag1", a.generation);
  expect(t.verify(a.token)).toBeUndefined();
  expect(t.verify(b.token)?.generation).toBe(b.generation);
  expect(t.verify(undefined)).toBeUndefined();
  expect(t.verify("nope")).toBeUndefined();
  t.revokeAll();
  expect(t.verify(b.token)).toBeUndefined();
});

test("only a digest is held: the plaintext appears nowhere in the instance", () => {
  const t = new AgentTokens();
  const { token } = t.mint("ag1");
  expect(
    JSON.stringify([...(t as never as { byHash: Map<string, unknown> }).byHash]),
  ).not.toContain(token);
});
