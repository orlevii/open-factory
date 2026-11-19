import { existsSync } from "node:fs";
import { createClaudeDriver } from "@open-factory/harness";
import { createFakeClaude } from "@open-factory/harness/testing";
import { expect, test } from "vitest";
import { CredentialVerifier } from "./verify.ts";

test("success: env is minimal, haiku, temp dir removed", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const v = new CredentialVerifier({
    driver: createClaudeDriver(),
    claudeBin: fake.bin,
    serverEnv: {
      PATH: process.env.PATH,
      HOME: "/h",
      DATABASE_URL: "x",
      ANTHROPIC_API_KEY: "server",
      FACTORY_SECRET_KEY: "k",
      SSH_AUTH_SOCK: "/s",
    },
  });
  expect(await v.verify("oauth_token", "tok")).toEqual({ ok: true });
  const start = fake.log().find((e) => e.kind === "start");
  if (start?.kind !== "start") throw new Error("the fake never started");
  expect(
    Object.keys(start.env)
      .filter(
        (k) =>
          !k.startsWith("FAKE_") &&
          k !== "PWD" &&
          k !== "SHLVL" &&
          k !== "_" &&
          k !== "__CF_USER_TEXT_ENCODING",
      )
      .sort(),
  ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  expect(start.argv).toEqual(expect.arrayContaining(["--model", "haiku"]));
  expect(existsSync(start.env.CLAUDE_CONFIG_DIR as string)).toBe(false);
});

test("api key goes in ANTHROPIC_API_KEY, not the oauth variable", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const v = new CredentialVerifier({ driver: createClaudeDriver(), claudeBin: fake.bin });
  expect(await v.verify("api_key", "sk-x")).toEqual({ ok: true });
  const start = fake.log().find((e) => e.kind === "start");
  if (start?.kind !== "start") throw new Error("the fake never started");
  expect(start.env.ANTHROPIC_API_KEY).toBe("sk-x");
  expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("401 → rejected; api_key wording", async () => {
  const fake = createFakeClaude({ scenario: "invalid-token" });
  const v = new CredentialVerifier({ driver: createClaudeDriver(), claudeBin: fake.bin });
  expect(await v.verify("oauth_token", "bad")).toEqual({
    ok: false,
    kind: "rejected",
    message: "Claude rejected this token. Create a new one with `claude setup-token`.",
  });
  expect(await v.verify("api_key", "bad")).toMatchObject({
    ok: false,
    message: "Claude rejected this API key.",
  });
});

test("no session / timeout → unreachable", async () => {
  const v = new CredentialVerifier({
    driver: createClaudeDriver(),
    claudeBin: "/nonexistent/claude",
  });
  expect(await v.verify("oauth_token", "x")).toEqual({
    ok: false,
    kind: "unreachable",
    message: "Couldn't reach Claude to verify. Try again.",
  });
});

test("a process that never answers times out as unreachable", async () => {
  const fake = createFakeClaude({ scenario: { onUser: [{ sleep: 60_000 }] } });
  const v = new CredentialVerifier({
    driver: createClaudeDriver(),
    claudeBin: fake.bin,
    timeoutMs: 300,
  });
  expect((await v.verify("oauth_token", "x")).ok).toBe(false);
});
