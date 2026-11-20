import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { AgentRuntimeSpec } from "../types.ts";
import { localTransport } from "./local.ts";

const spec: AgentRuntimeSpec = {
  agentId: "a1",
  slug: "dev",
  cwd: mkdtempSync(path.join(tmpdir(), "agent-")),
  env: { PATH: process.env.PATH ?? "" },
  claudeBin: "/bin/sh",
  runtime: "local",
  permissionMode: "auto",
  mounts: [],
};

test("localTransport: SIGTERM ends a child; forceKill SIGKILLs one that traps TERM", async () => {
  const t = localTransport(spec, ["-c", "trap '' TERM; echo up; sleep 30"]);
  // Wait until the trap is installed, or SIGTERM can land before it and kill the shell.
  await t.stdout[Symbol.asyncIterator]().next();
  expect(await t.terminate()).toBe(true);
  await t.forceKill();
  expect((await t.exit).signal).toBe("SIGKILL");
});

test("localTransport: forceKill also ends a child forked while the group kill lands", async () => {
  // The leader forks in a loop, so the group SIGKILL races a fork in flight. On macOS the new child can miss it and
  // keep the pipes open, so `exit` never resolved (19 of 20 runs hung before the sweep on the leader's exit).
  const t = localTransport(spec, [
    "-c",
    "echo up; i=0; while [ $i -lt 2000 ]; do sleep 30 & i=$((i+1)); done; wait",
  ]);
  await t.stdout[Symbol.asyncIterator]().next();
  await t.forceKill();
  expect((await t.exit).signal).toBe("SIGKILL");
});

test("localTransport: lines are delivered before exit; write after exit rejects", async () => {
  const t = localTransport(spec, ["-c", "echo one; echo two >&2"]);
  const out: string[] = [];
  const err: string[] = [];
  await Promise.all([
    (async () => {
      for await (const l of t.stdout) out.push(l);
    })(),
    (async () => {
      for await (const l of t.stderr) err.push(l);
    })(),
  ]);
  expect(await t.exit).toEqual({ code: 0, signal: null });
  expect(out).toEqual(["one"]);
  expect(err).toEqual(["two"]);
  await expect(t.write("x")).rejects.toMatchObject({ name: "ProcessNotRunningError" });
});
