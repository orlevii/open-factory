import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { ProcessJournal } from "./journal.ts";

// Real processes, no model: a stand-in "claude" (node) starts `sleep 600` in its own session (detached = setsid),
// so killing the parent's process group would miss it; only the journal names it.
const PARENT = `
const { spawn } = require("node:child_process");
const c = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
console.log(c.pid);
setInterval(() => {}, 1000);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
});

async function startParent(): Promise<{ parent: ChildProcess; sleepPid: number }> {
  const parent = spawn(process.execPath, ["-e", PARENT], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!parent.pid) throw new Error("no pid");
  spawned.push(parent.pid);
  const sleepPid = await new Promise<number>((resolve, reject) => {
    parent.stdout?.once("data", (b: Buffer) => resolve(Number(String(b).trim())));
    parent.once("error", reject);
  });
  spawned.push(sleepPid);
  return { parent, sleepPid };
}

test("live: a crash leaves a setsid sleep; reap kills it", async () => {
  const { parent, sleepPid } = await startParent();
  const journal = new ProcessJournal();
  const snap = await journal.snapshot(parent.pid as number);
  expect(snap.descendants.map((d) => d.pid)).toContain(sleepPid);

  const exited = new Promise((r) => parent.once("exit", r));
  process.kill(parent.pid as number, "SIGKILL"); // the crash
  await exited;
  expect(alive(sleepPid)).toBe(true); // the leftover

  // Claude itself is gone (no matching start time): only the sleep is signalled.
  expect(await journal.reap(snap)).toBe(1);
  expect(await until(() => !alive(sleepPid))).toBe(true);
});

test("live: a journaled pid with another start time is never signalled", async () => {
  const { sleepPid } = await startParent();
  const journal = new ProcessJournal();
  expect(
    await journal.reap({ descendants: [{ pid: sleepPid, start: "Thu Jan 1 00:00:00 1970" }] }),
  ).toBe(0);
  expect(alive(sleepPid)).toBe(true);
});
