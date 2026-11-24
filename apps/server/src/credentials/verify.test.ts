import { existsSync } from "node:fs";
import {
  AsyncQueue,
  createClaudeDriver,
  type HarnessDriver,
  type HarnessProcess,
  type LiveEvent,
  localTransport,
} from "@open-factory/harness";
import { createFakeClaude } from "@open-factory/harness/testing";
import type { HarnessEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { FIELD_MSG } from "../field-messages.ts";
import { CredentialVerifier } from "./verify.ts";

test("success: env is minimal, haiku, temp dir removed", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const v = new CredentialVerifier({
    driver: createClaudeDriver({ transports: { local: localTransport } }),
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
  const v = new CredentialVerifier({
    driver: createClaudeDriver({ transports: { local: localTransport } }),
    claudeBin: fake.bin,
  });
  expect(await v.verify("api_key", "sk-x")).toEqual({ ok: true });
  const start = fake.log().find((e) => e.kind === "start");
  if (start?.kind !== "start") throw new Error("the fake never started");
  expect(start.env.ANTHROPIC_API_KEY).toBe("sk-x");
  expect(start.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

test("401 → rejected; api_key wording", async () => {
  const fake = createFakeClaude({ scenario: "invalid-token" });
  const v = new CredentialVerifier({
    driver: createClaudeDriver({ transports: { local: localTransport } }),
    claudeBin: fake.bin,
  });
  expect(await v.verify("oauth_token", "bad")).toEqual({
    ok: false,
    kind: "rejected",
    message: FIELD_MSG.tokenRejected,
  });
  expect(await v.verify("api_key", "bad")).toMatchObject({
    ok: false,
    message: FIELD_MSG.apiKeyRejected,
  });
});

test("a missing claude binary → unreachable", async () => {
  const v = new CredentialVerifier({
    driver: createClaudeDriver({ transports: { local: localTransport } }),
    claudeBin: "/nonexistent/claude",
  });
  expect(await v.verify("oauth_token", "x")).toEqual({
    ok: false,
    kind: "unreachable",
    message: FIELD_MSG.claudeUnreachable,
  });
});

test("a process that never answers times out as unreachable", async () => {
  const fake = createFakeClaude({ scenario: { onUser: [{ sleep: 60_000 }] } });
  const v = new CredentialVerifier({
    driver: createClaudeDriver({ transports: { local: localTransport } }),
    claudeBin: fake.bin,
    timeoutMs: 300,
  });
  const started = Date.now();
  expect(await v.verify("oauth_token", "x")).toEqual({
    ok: false,
    kind: "unreachable",
    message: FIELD_MSG.claudeUnreachable,
  });
  // timeoutMs (300 ms) took effect rather than the 60 s default.
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the verification process's live queue is drained", async () => {
  const events = new AsyncQueue<HarnessEvent>();
  const live = new AsyncQueue<LiveEvent>();
  for (let i = 0; i < 100; i++)
    live.push({ type: "text_delta", messageId: "m", index: 0, text: "x", line: i + 1 });
  const proc = {
    events,
    live,
    pid: 1,
    send: async () => {
      events.push({ type: "turn_end", isError: false, numTurns: 1 });
    },
    control: async () => {},
    stop: async () => {
      events.end();
      live.end();
      return { code: 0, signal: null };
    },
  } as unknown as HarnessProcess;
  const driver = { start: () => proc } as unknown as HarnessDriver;
  const v = new CredentialVerifier({ driver, claudeBin: "claude" });
  expect(await v.verify("api_key", "sk-x")).toEqual({ ok: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(live.pending).toBe(0);
});
