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
  // Spawn-and-kill is the load-sensitive part: the full suite runs ~100 workers, so the default 5 s
  // test timeout, not the logic, is what flaked (150 concurrent runs under CPU load never failed).
}, 20_000);

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
