import { randomUUID } from "node:crypto";
import type { HarnessEvent } from "@open-factory/shared";
import { AsyncQueue } from "../async-queue.ts";
import { renderEnvelopes } from "../envelope.ts";
import type { Transport } from "../transport/types.ts";
import {
  type AgentRuntimeSpec,
  type ExitInfo,
  type FactoryMessage,
  type HarnessProcess,
  ProcessNotRunningError,
} from "../types.ts";
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
  private readonly mapper: MapperState;
  private readonly stderr = new StderrTail();
  private stopRequested = false;
  private stopping: Promise<ExitInfo> | undefined;
  private exited: ExitInfo | undefined;
  private readonly exitPromise: Promise<ExitInfo>;

  constructor(
    spec: AgentRuntimeSpec,
    opts: { resumeSessionId?: string },
    private readonly transport: Transport,
    private readonly log: DriverLog = silent,
  ) {
    const ctx = { agent: spec.slug };
    this.mapper = createMapperState({
      resumed: Boolean(opts.resumeSessionId),
      onUnmapped: (kind) => log.warn({ ...ctx, kind }, "unmapped stream-json line"),
    });
    const pumpStdout = async () => {
      for await (const line of transport.stdout) {
        if (!line.trim()) continue;
        log.debug({ ...ctx, line }, "claude stdout");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          log.warn({ ...ctx, line: line.slice(0, 500) }, "non-JSON stdout line");
          continue;
        }
        for (const e of mapLine(parsed, this.mapper)) this.events.push(e);
      }
    };
    const pumpStderr = async () => {
      for await (const line of transport.stderr) {
        log.warn({ ...ctx, line }, "claude stderr");
        this.stderr.push(line);
      }
    };
    // Every line is mapped before `exited`: the transport ends the iterables once the process is gone.
    this.exitPromise = Promise.all([pumpStdout(), pumpStderr(), transport.exit]).then(([, , x]) => {
      if (x.spawnError) {
        const message =
          x.spawnError.code === "ENOENT" || x.spawnError.code === "EACCES"
            ? "Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH"
            : `Could not start Claude Code: ${x.spawnError.message}`;
        this.events.push({ type: "error", source: "spawn", message });
      }
      const info: ExitInfo = { code: x.code, signal: x.signal };
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
      return info;
    });
  }

  get pid() {
    return this.transport.pid;
  }

  private write(obj: unknown): Promise<void> {
    if (this.exited) return Promise.reject(new ProcessNotRunningError());
    // Every line is JSON.stringify output: a malformed stdin line kills Claude (S0).
    return this.transport.write(JSON.stringify(obj));
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

  /** Close stdin, wait graceMs, SIGTERM, wait termWaitMs. Never SIGKILL (it orphans background shells);
   *  `forceKill()` is the explicit last resort. Idempotent: every call returns the same promise. */
  stop(opts: { graceMs?: number; termWaitMs?: number } = {}): Promise<ExitInfo> {
    this.stopping ??= this.doStop(opts);
    return this.stopping;
  }

  private async doStop({
    graceMs = 3000,
    termWaitMs = 10_000,
  }: {
    graceMs?: number;
    termWaitMs?: number;
  }): Promise<ExitInfo> {
    if (this.exited) return this.exited;
    this.stopRequested = true;
    this.transport.endInput();
    const winner = await exitWithin(this.exitPromise, graceMs);
    if (winner) return winner;
    await this.transport.terminate();
    const after = await exitWithin(this.exitPromise, termWaitMs);
    if (after) return after;
    this.log.error({ pid: this.transport.pid }, "claude did not exit after SIGTERM");
    return { code: null, signal: null, timedOut: true };
  }

  forceKill(): Promise<void> {
    return this.transport.forceKill();
  }
}
