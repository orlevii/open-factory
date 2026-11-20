import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { HarnessEvent } from "@open-factory/shared";
import { AsyncQueue } from "../async-queue.ts";
import { renderEnvelopes } from "../envelope.ts";
import {
  type AgentRuntimeSpec,
  type ExitInfo,
  type FactoryMessage,
  type HarnessDriver,
  type HarnessProcess,
  ProcessNotRunningError,
} from "../types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createMapperState, flushMapper, type MapperState, mapLine } from "./mapper.ts";

export interface DriverLog {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
const silent: DriverLog = { debug() {}, warn() {}, error() {} };

const STDERR_LINES = 50;
const STDERR_BYTES = 8 * 1024;

/** Resolves with the exit info, or undefined after `ms`. The timer is cleared as soon as the race settles,
 *  so it never keeps the process alive after the child is gone. */
async function exitWithin(exit: Promise<ExitInfo>, ms: number): Promise<ExitInfo | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), ms);
  });
  try {
    return await Promise.race([exit, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the last STDERR_LINES lines / STDERR_BYTES bytes (UTF-8). An over-long line is cut to its tail. */
export class StderrTail {
  private lines: string[] = [];
  private sizes: number[] = [];
  private bytes = 0;

  push(line: string): void {
    let size = Buffer.byteLength(line);
    if (size > STDERR_BYTES) {
      // Keep the tail; a cut may split a multi-byte char, which decodes to U+FFFD at the start only.
      line = Buffer.from(line)
        .subarray(size - STDERR_BYTES)
        .toString();
      size = Buffer.byteLength(line);
    }
    this.lines.push(line);
    this.sizes.push(size);
    this.bytes += size;
    while (
      this.lines.length > 1 &&
      (this.lines.length > STDERR_LINES || this.bytes > STDERR_BYTES)
    ) {
      this.lines.shift();
      this.bytes -= this.sizes.shift() ?? 0;
    }
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

export class ClaudeProcess implements HarnessProcess {
  readonly events: AsyncQueue<HarnessEvent> = new AsyncQueue();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly mapper: MapperState;
  private readonly stderr = new StderrTail();
  private stopRequested = false;
  private exited: ExitInfo | undefined;
  private readonly exitPromise: Promise<ExitInfo>;

  constructor(
    spec: AgentRuntimeSpec,
    opts: { resumeSessionId?: string },
    private readonly log: DriverLog = silent,
  ) {
    const ctx = { agent: spec.slug };
    this.mapper = createMapperState({
      resumed: Boolean(opts.resumeSessionId),
      onUnmapped: (kind) => log.warn({ ...ctx, kind }, "unmapped stream-json line"),
    });
    // detached: own process group, so a terminal Ctrl+C reaches only the server, which stops us gracefully.
    this.child = spawn(spec.claudeBin, buildClaudeArgs(spec, opts), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let resolveExit!: (i: ExitInfo) => void;
    this.exitPromise = new Promise((r) => {
      resolveExit = r;
    });
    const finish = (info: ExitInfo) => {
      if (this.exited) return;
      this.exited = info;
      for (const e of flushMapper(this.mapper)) this.events.push(e);
      this.events.push({
        type: "exited",
        code: info.code,
        signal: info.signal,
        stderrTail: this.stderr.toString(),
        expected: this.stopRequested,
      });
      this.events.end();
      resolveExit(info);
    };
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child.pid !== undefined) return log.error({ ...ctx, err }, "claude process error");
      const message =
        err.code === "ENOENT" || err.code === "EACCES"
          ? "Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH"
          : `Could not start Claude Code: ${err.message}`;
      this.events.push({ type: "error", source: "spawn", message });
      finish({ code: null, signal: null });
    });
    this.child.stdin.on("error", (err) => log.warn({ ...ctx, err }, "claude stdin error"));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      log.debug({ ...ctx, line }, "claude stdout");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return log.warn({ ...ctx, line: line.slice(0, 500) }, "non-JSON stdout line");
      }
      for (const e of mapLine(parsed, this.mapper)) this.events.push(e);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      log.warn({ ...ctx, line }, "claude stderr");
      this.stderr.push(line);
    });
    // "close" fires after stdout/stderr are drained, so every line is mapped before `exited`.
    this.child.on("close", (code, signal) => finish({ code, signal }));
  }

  get pid() {
    return this.child.pid;
  }

  private write(obj: unknown): Promise<void> {
    if (this.exited || this.child.stdin.writableEnded || this.child.stdin.destroyed)
      return Promise.reject(new ProcessNotRunningError());
    // Every line is JSON.stringify output: a malformed stdin line kills Claude (S0).
    return new Promise((resolve, reject) =>
      this.child.stdin.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : resolve())),
    );
  }

  send(messages: FactoryMessage[]): Promise<void> {
    return this.write({
      type: "user",
      message: { role: "user", content: renderEnvelopes(messages) },
    });
  }

  control(cmd: "compact" | "clear" | "interrupt", arg?: string): Promise<void> {
    if (cmd === "interrupt")
      return this.write({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      });
    if (cmd === "compact") this.mapper.manualCompactPending = true;
    const text = cmd === "compact" ? (arg ? `/compact ${arg}` : "/compact") : "/clear";
    return this.write({ type: "user", message: { role: "user", content: text } });
  }

  /** Close stdin, wait graceMs, SIGTERM, wait termWaitMs. Never SIGKILL (it orphans background shells). */
  async stop(opts: { graceMs?: number; termWaitMs?: number } = {}): Promise<ExitInfo> {
    const { graceMs = 3000, termWaitMs = 10_000 } = opts;
    if (this.exited) return this.exited;
    this.stopRequested = true;
    this.child.stdin.end();
    const winner = await exitWithin(this.exitPromise, graceMs);
    if (winner) return winner;
    this.child.kill("SIGTERM");
    const after = await exitWithin(this.exitPromise, termWaitMs);
    if (after) return after;
    this.log.error({ pid: this.child.pid }, "claude did not exit after SIGTERM");
    return { code: null, signal: null, timedOut: true };
  }
}

export function createClaudeDriver(log?: DriverLog): HarnessDriver {
  return { start: (spec, opts) => new ClaudeProcess(spec, opts, log) };
}
