import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncQueue } from "../async-queue.ts";
import { type AgentRuntimeSpec, ProcessNotRunningError } from "../types.ts";
import type { Transport, TransportExit } from "./types.ts";

/** Spawns the claude binary on the host: detached (own process group, so a terminal Ctrl+C reaches only
 *  the server, which stops us gracefully), env = spec.env. */
export function localTransport(spec: AgentRuntimeSpec, args: string[]): Transport {
  const child = spawn(spec.claudeBin, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const stdout = new AsyncQueue<string>();
  const stderr = new AsyncQueue<string>();
  let settled = false;
  let resolveExit!: (e: TransportExit) => void;
  const exit = new Promise<TransportExit>((r) => {
    resolveExit = r;
  });
  const settle = (e: TransportExit) => {
    if (settled) return;
    settled = true;
    stdout.end();
    stderr.end();
    resolveExit(e);
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    // After a successful spawn an "error" (e.g. a failed kill) does not end the process.
    if (child.pid !== undefined) return;
    settle({ code: null, signal: null, spawnError: { code: err.code, message: err.message } });
  });
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (l) => stdout.push(l));
  createInterface({ input: child.stderr }).on("line", (l) => stderr.push(l));
  // "close" fires after stdout/stderr are drained, so every line is queued before `exit` resolves.
  child.on("close", (code, signal) => settle({ code, signal }));

  return {
    get pid() {
      return child.pid;
    },
    write(line) {
      if (settled || child.stdin.writableEnded || child.stdin.destroyed)
        return Promise.reject(new ProcessNotRunningError());
      return new Promise((resolve, reject) =>
        child.stdin.write(`${line}\n`, (err) => (err ? reject(err) : resolve())),
      );
    },
    endInput() {
      child.stdin.end();
    },
    stdout,
    stderr,
    exit,
    async terminate() {
      return child.kill("SIGTERM");
    },
    async forceKill() {
      // The whole group, so a child that traps TERM does not leave its own children holding the pipes.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}
