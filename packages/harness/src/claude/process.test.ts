import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { createFakeClaude } from "../../testing/index.ts";
import { type AgentRuntimeSpec, ProcessNotRunningError } from "../types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createClaudeDriver } from "./process.ts";

const spec = (bin: string, over: Partial<AgentRuntimeSpec> = {}): AgentRuntimeSpec => ({
  agentId: "a1",
  slug: "dev",
  cwd: mkdtempSync(path.join(tmpdir(), "agent-")),
  env: {
    PATH: process.env.PATH ?? "",
    CLAUDE_CONFIG_DIR: "/tmp/cfg",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
  },
  claudeBin: bin,
  permissionMode: "auto",
  ...over,
});

async function collectUntil(
  it: AsyncIterable<HarnessEvent>,
  pred: (e: HarnessEvent) => boolean,
  into: HarnessEvent[],
) {
  for await (const e of it) {
    into.push(e);
    if (pred(e)) return;
  }
}

test("args: fixed flags, resume and model only when given", () => {
  const base = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "auto",
  ];
  expect(buildClaudeArgs(spec("c"), {})).toEqual(base);
  expect(buildClaudeArgs(spec("c", { model: "haiku" }), { resumeSessionId: "s1" })).toEqual([
    ...base,
    "--resume",
    "s1",
    "--model",
    "haiku",
  ]);
});

test("send writes one envelope turn; events are mapped; env passes through unchanged", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "turn_end", events);
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "hi" }]);
  await done;
  expect(events.map((e) => e.type)).toEqual([
    "session_started",
    "turn_started",
    "assistant_text",
    "usage",
    "turn_end",
  ]);
  const log = fake.log();
  const stdin = log.find((e) => e.kind === "stdin");
  expect(stdin && JSON.parse(stdin.line)).toEqual({
    type: "user",
    message: {
      role: "user",
      content:
        '<factory-message from="@or" kind="message" urgent="false" id="m1">\nhi\n</factory-message>',
    },
  });
  const start = log.find((e) => e.kind === "start");
  expect(start?.kind === "start" && start.env.CLAUDE_CONFIG_DIR).toBe("/tmp/cfg");
  expect(start?.kind === "start" && start.env.DATABASE_URL).toBeUndefined();
  await p.stop({ graceMs: 2000 });
});

test("runs in its own process group", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  await new Promise((r) => setTimeout(r, 200));
  // the wrapper execs node, so the pid is the fake itself
  const pgid = Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(p.pid)])
      .toString()
      .trim(),
  );
  expect(pgid).toBe(p.pid);
  await p.stop({ graceMs: 2000 });
});

test("compact writes /compact with focus and marks the mapper so a failure is manual", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "turn_end", events);
  await p.control("compact", "keep the API");
  await done;
  expect(fake.log().find((e) => e.kind === "stdin")).toMatchObject({
    line: JSON.stringify({
      type: "user",
      message: { role: "user", content: "/compact keep the API" },
    }),
  });
  expect(events.find((e) => e.type === "compacted")).toMatchObject({ trigger: "manual" });
  await p.stop({ graceMs: 2000 });
});

test("interrupt writes a control_request", async () => {
  const fake = createFakeClaude({ scenario: "long-tool" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "turn_end", events);
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "ping" }]);
  while (!events.some((e) => e.type === "tool_call")) await new Promise((r) => setTimeout(r, 20));
  await p.control("interrupt");
  await done;
  expect(events.at(-1)).toMatchObject({
    type: "turn_end",
    isError: true,
    terminalReason: "aborted_tools",
  });
  const ctl = fake
    .log()
    .filter((e) => e.kind === "stdin")
    .map((e) => (e.kind === "stdin" ? JSON.parse(e.line) : null));
  expect(ctl[1]).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
  await p.stop({ graceMs: 2000 });
});

test("stop closes stdin; the process exits 0 and emits exited{expected:true}", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  const all = collectUntil(p.events, () => false, events);
  const info = await p.stop({ graceMs: 3000 });
  await all;
  expect(info).toMatchObject({ code: 0 });
  expect(events.at(-1)).toMatchObject({ type: "exited", code: 0, expected: true });
  await expect(
    p.send([{ id: "m", from: "@or", kind: "message", urgent: false, body: "x" }]),
  ).rejects.toBeInstanceOf(ProcessNotRunningError);
});

test("stop falls back to SIGTERM when the process doesn't exit on stdin close", async () => {
  const fake = createFakeClaude({ scenario: "long-tool" });
  const p = createClaudeDriver().start(spec(fake.bin), {});
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "ping" }]);
  await new Promise((r) => setTimeout(r, 300));
  const info = await p.stop({ graceMs: 200, termWaitMs: 5000 });
  expect(info.code ?? info.signal).toBeTruthy(); // 143 (handled) or SIGTERM
});

test("unexpected exit carries the stderr tail; resume of an unknown id maps to a resume error", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver().start(spec(fake.bin), {
    resumeSessionId: "00000000-0000-4000-8000-000000000009",
  });
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "error", events);
  await done;
  expect(events[0]).toMatchObject({ type: "error", source: "resume" });
  const info = await p.stop({ graceMs: 2000 });
  expect(info.code).toBe(1);
});

test("a missing binary is a spawn error followed by exited", async () => {
  const p = createClaudeDriver().start(spec("/nonexistent/claude"), {});
  const events: HarnessEvent[] = [];
  await collectUntil(p.events, () => false, events);
  expect(events.map((e) => e.type)).toEqual(["error", "exited"]);
  expect(events[0]).toMatchObject({
    source: "spawn",
    message: "Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH",
  });
  expect(events[1]).toMatchObject({ expected: false });
});
