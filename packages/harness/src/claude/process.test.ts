import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@open-factory/shared";
import { expect, test } from "vitest";
import { createFakeClaude, FakeTransport } from "../../testing/index.ts";
import { localTransport } from "../transport/local.ts";
import { type AgentRuntimeSpec, ProcessNotRunningError } from "../types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createClaudeDriver } from "./driver.ts";
import { ClaudeProcess, StderrTail } from "./process.ts";

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
  runtime: "local",
  permissionMode: "auto",
  mounts: [],
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "turn_end", events);
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "hi" }]);
  await done;
  expect(events.map((e) => e.type)).toEqual([
    "session_started",
    "turn_started",
    "assistant_text",
    "rate_limit_status",
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
  // spawn() returns once the child has exec'd, so its setsid() already happened: no wait needed. The wrapper execs
  // node, so the pid is the fake itself.
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "ping" }]);
  await collectUntil(p.events, (e) => e.type === "tool_call", events);
  await p.control("interrupt");
  await collectUntil(p.events, (e) => e.type === "turn_end", events);
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
  const events: HarnessEvent[] = [];
  // A finished turn proves the fake is up and reading stdin. Stopping a process that hasn't booted yet races the
  // grace against node's startup (seconds under full-suite load), and a SIGTERM then wins instead of the stdin close.
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "hi" }]);
  await collectUntil(p.events, (e) => e.type === "turn_end", events);
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
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {});
  await p.send([{ id: "m1", from: "@or", kind: "message", urgent: false, body: "ping" }]);
  // Mid-tool, so the fake is up (its SIGTERM handler installed) and won't exit on the stdin close.
  await collectUntil(p.events, (e) => e.type === "tool_call", []);
  const info = await p.stop({ graceMs: 200, termWaitMs: 5000 });
  expect(info).toMatchObject({ code: 143 });
});

test("resume of an unknown id maps to a resume error and exits 1", async () => {
  const fake = createFakeClaude({ scenario: "reply" });
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(fake.bin), {
    resumeSessionId: "00000000-0000-4000-8000-000000000009",
  });
  const events: HarnessEvent[] = [];
  const done = collectUntil(p.events, (e) => e.type === "error", events);
  await done;
  expect(events[0]).toMatchObject({ type: "error", source: "resume" });
  const exited = events.find((e) => e.type === "exited");
  expect(exited).toBeUndefined(); // collection stopped at the error; exited follows
  const info = await p.stop({ graceMs: 2000 });
  expect(info.code).toBe(1);
});

test("a missing binary is a spawn error followed by exited", async () => {
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(
    spec("/nonexistent/claude"),
    {},
  );
  const events: HarnessEvent[] = [];
  await collectUntil(p.events, () => false, events);
  expect(events.map((e) => e.type)).toEqual(["error", "exited"]);
  expect(events[0]).toMatchObject({
    source: "spawn",
    message: "Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH",
  });
  expect(events[1]).toMatchObject({ expected: false });
});

const scriptBin = (body: string) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "script-")), "claude");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

test("an unexpected exit carries the stderr tail in exited", async () => {
  const bin = scriptBin("echo boom-1 >&2\necho boom-2 >&2\nexit 3");
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(spec(bin), {});
  const events: HarnessEvent[] = [];
  await collectUntil(p.events, () => false, events);
  expect(events.at(-1)).toMatchObject({
    type: "exited",
    code: 3,
    expected: false,
    stderrTail: "boom-1\nboom-2",
  });
});

test("StderrTail keeps the last 50 lines, caps bytes, and truncates an over-long line to its tail", () => {
  const lines = new StderrTail();
  for (let i = 0; i < 80; i++) lines.push(`l${i}`);
  const kept = lines.toString().split("\n");
  expect(kept).toHaveLength(50);
  expect(kept[0]).toBe("l30");
  expect(kept.at(-1)).toBe("l79");

  const bytes = new StderrTail();
  for (let i = 0; i < 20; i++) bytes.push("é".repeat(500)); // 1000 bytes each
  expect(Buffer.byteLength(bytes.toString())).toBeLessThanOrEqual(8 * 1024);
  expect(bytes.toString().split("\n").length).toBeLessThanOrEqual(8);

  const long = new StderrTail();
  long.push(`${"x".repeat(20_000)}END`);
  expect(long.toString().endsWith("xxxEND")).toBe(true);
  expect(Buffer.byteLength(long.toString())).toBeLessThanOrEqual(8 * 1024);
});

test("stop reports timedOut when the process ignores SIGTERM", async () => {
  const ready = path.join(mkdtempSync(path.join(tmpdir(), "ready-")), "up");
  // Ignores SIGTERM and stdin close; exits by itself after ~3 s so nothing is left behind.
  const bin = scriptBin(
    `trap '' TERM\ntouch "$READY"\ni=0\nwhile [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done`,
  );
  const base = spec(bin);
  const p = createClaudeDriver({ transports: { local: localTransport } }).start(
    { ...base, env: { ...base.env, READY: ready } },
    {},
  );
  while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
  const info = await p.stop({ graceMs: 100, termWaitMs: 200 });
  expect(info).toEqual({ code: null, signal: null, timedOut: true });
  // The escalation's SIGKILL, awaited, so the test leaves no process behind.
  await p.forceKill();
  const events: HarnessEvent[] = [];
  await collectUntil(p.events, () => false, events);
  expect(events.at(-1)).toMatchObject({ type: "exited", signal: "SIGKILL" });
});

test("stop() is idempotent: one stdin close, one SIGTERM, one promise", async () => {
  const t = new FakeTransport();
  const p = new ClaudeProcess(spec("c"), {}, t);
  const a = p.stop({ graceMs: 10, termWaitMs: 1000 });
  const b = p.stop({ graceMs: 10, termWaitMs: 1000 });
  expect(a).toBe(b);
  await new Promise((r) => setTimeout(r, 50));
  t.exitWith(143);
  await a;
  expect(t.endInputCalls).toBe(1);
  expect(t.terminateCalls).toBe(1);
});

test("terminate() returning false falls through to the timeout", async () => {
  const t = new FakeTransport({ terminateResult: false });
  const p = new ClaudeProcess(spec("c"), {}, t);
  await expect(p.stop({ graceMs: 5, termWaitMs: 5 })).resolves.toMatchObject({ timedOut: true });
});

test("forceKill reaches the transport", async () => {
  const t = new FakeTransport();
  const p = new ClaudeProcess(spec("c"), {}, t);
  await p.forceKill();
  expect(t.forceKillCalls).toBe(1);
});

test("a throwing mapper line is logged and exited is still emitted", async () => {
  const warns: string[] = [];
  const t = new FakeTransport();
  const p = new ClaudeProcess(spec("c"), {}, t, {
    debug() {},
    error() {},
    warn: (_o, msg) => void warns.push(msg),
  });
  // `message` is a getter that throws, so the mapper blows up on this line.
  const bad = '{"type":"assistant"}';
  const orig = JSON.parse;
  JSON.parse = ((s: string, r?: never) =>
    s === bad
      ? Object.defineProperty({ type: "system" }, "subtype", {
          get() {
            throw new Error("boom");
          },
        })
      : orig(s, r)) as typeof JSON.parse;
  try {
    t.emitStdout(bad);
    t.exitWith(0);
    const events: HarnessEvent[] = [];
    await collectUntil(p.events, () => false, events);
    expect(events.at(-1)).toMatchObject({ type: "exited" });
    expect(warns).toContain("could not map stdout line");
  } finally {
    JSON.parse = orig;
  }
});

test("FakeTransport.write rejects after endInput and after exit", async () => {
  const a = new FakeTransport();
  a.endInput();
  await expect(a.write("x")).rejects.toBeInstanceOf(ProcessNotRunningError);
  const b = new FakeTransport();
  b.exitWith(0);
  await expect(b.write("x")).rejects.toBeInstanceOf(ProcessNotRunningError);
});
