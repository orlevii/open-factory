import { expect, test } from "vitest";
import { capOutput, redactOutput } from "./redact.ts";

test("redaction hides URL userinfo and a Claude token", () => {
  expect(redactOutput("clone https://user:pw@host/x sk-ant-oat01-abc")).toBe(
    "clone https://[redacted]@host/x [redacted]",
  );
});

test("redaction covers tokens, bearer, query secrets and userinfo with @", () => {
  expect(redactOutput("https://u:p@ss@h/x")).toBe("https://[redacted]@h/x");
  expect(redactOutput("ssh://git:pw@h/x")).toBe("ssh://[redacted]@h/x");
  const out = redactOutput(
    "ghp_abcDEF123 github_pat_11AA_bb glpat-xyz_1-2 Authorization: Bearer abc.def?x=1 u?access_token=zzz&password=hunter2&token=t1",
  );
  for (const secret of [
    "ghp_abcDEF123",
    "github_pat_11AA_bb",
    "glpat-xyz_1-2",
    "abc.def",
    "zzz",
    "hunter2",
    "t1",
  ])
    expect(out).not.toContain(secret);
});

test("capOutput keeps the last 20 lines", () => {
  const few = Array.from({ length: 30 }, (_, i) => `short ${i}`).join("\n");
  expect(capOutput(few).split("\n")).toHaveLength(20);
  expect(capOutput(few)).toContain("short 29");
  expect(capOutput(few)).not.toContain("short 9\n");
});

test("capOutput keeps at most 4 KB, the tail", () => {
  const noisy = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(400)}`).join("\n");
  const out = capOutput(noisy);
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
  expect(out).toContain("line 59 ");
  expect(out).not.toContain("line 10 ");
});

test("redactOutput on 10 MB of one token finishes quickly", () => {
  const started = performance.now();
  for (const token of ["a".repeat(10_000_000), `${"a".repeat(10_000_000)}://`]) {
    expect(redactOutput(token)).toBe(token);
  }
  expect(performance.now() - started).toBeLessThan(1000);
});
