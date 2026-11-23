import { randomUUID } from "node:crypto";
import { boundVersion, type Command, type HarnessEvent, parseCommands } from "@open-factory/shared";
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
import type { LiveEvent } from "./live.ts";
import { createMapperState, flushMapper, type MapperState, mapLine } from "./mapper.ts";

export interface DriverLog {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
const silent: DriverLog = { debug() {}, warn() {}, error() {} };

const STDERR_LINES = 50;
/** U3 §13.3: how long `initialize` may take before the process goes on without a command list. */
export const COMMANDS_TIMEOUT_MS = 5000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** Keeps the well-formed entries of `initialize`'s `commands` (bounded, a warning per dropped one); else no list. */
function commandsOf(response: Json | undefined, log: DriverLog): Command[] | undefined {
  if (!Array.isArray(response?.commands)) return undefined;
  return parseCommands(response.commands, (entry) =>
    log.warn({ entry: JSON.stringify(entry)?.slice(0, 300) }, "dropped a malformed command entry"),
  );
}
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
  /** Partial-message events (U3 §11.1), never persisted; ends with `events`. */
  readonly live: AsyncQueue<LiveEvent> = new AsyncQueue();
  /** Each delivered event's stdout line, beside it so the event's shape stays as persisted. */
  private readonly lines = new WeakMap<object, number>();
  /** Non-empty stdout lines seen so far. */
  private line = 0;
  private readonly mapper: MapperState;
  private readonly stderr = new StderrTail();
  private stopRequested = false;
  private stopping: Promise<ExitInfo> | undefined;
  private exited: ExitInfo | undefined;
  private readonly exitPromise: Promise<ExitInfo>;
  /** Our control requests awaiting their `control_response`, by request id. */
  private readonly pending = new Map<string, (response: Json | undefined) => void>();
  private commandList: Promise<Command[] | undefined>;
  claudeCodeVersion: string | undefined;

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
        const lineNo = ++this.line;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          log.debug({ ...ctx, line }, "claude stdout");
          log.warn({ ...ctx, line: line.slice(0, 500) }, "non-JSON stdout line");
          continue;
        }
        // Partial messages are ~200 lines a turn: kept out of the debug log (U3 §11.1).
        if ((parsed as { type?: unknown } | null)?.type !== "stream_event")
          log.debug({ ...ctx, line }, "claude stdout");
        try {
          if (this.onControl(parsed)) continue;
          const { events, live } = mapLine(parsed, this.mapper, lineNo);
          for (const e of events) this.push(e, lineNo);
          for (const l of live) this.live.push(l);
        } catch (err) {
          // A mapper bug must not stop the pump: `exited` has to be sent.
          log.warn({ ...ctx, err, line: line.slice(0, 500) }, "could not map stdout line");
        }
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
      // Whatever the exit adds comes after every stdout line.
      const exitLine = ++this.line;
      if (x.spawnError) {
        const message =
          x.spawnError.code === "ENOENT" || x.spawnError.code === "EACCES"
            ? "Claude Code not found: set FACTORY_CLAUDE_BIN or put claude on PATH"
            : `Could not start Claude Code: ${x.spawnError.message}`;
        this.push({ type: "error", source: "spawn", message }, exitLine);
      }
      const info: ExitInfo = { code: x.code, signal: x.signal };
      this.exited = info;
      for (const resolve of this.pending.values()) resolve(undefined);
      try {
        for (const e of flushMapper(this.mapper)) this.push(e, exitLine);
      } catch (err) {
        log.warn({ ...ctx, err }, "could not flush mapper");
      }
      this.push(
        {
          type: "exited",
          code: info.code,
          signal: info.signal,
          stderrTail: this.stderr.toString(),
          expected: this.stopRequested,
        },
        exitLine,
      );
      this.events.end();
      this.live.end();
      return info;
    });
    // Sent first, as the Agent SDK does (spike §2). Re-sending it later in a process is unverified.
    this.commandList = this.request({ subtype: "initialize" }, COMMANDS_TIMEOUT_MS).then((r) => {
      this.claudeCodeVersion = boundVersion(r?.claude_code_version);
      return commandsOf(r, this.log);
    });
  }

  /** Writes a control request; resolves with its success payload, or undefined on an error, a timeout or an exit. */
  private request(request: Json, timeoutMs: number): Promise<Json | undefined> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const done = (r: Json | undefined) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      this.pending.set(id, done);
      this.write({ type: "control_request", request_id: id, request }).catch(() => done(undefined));
    });
  }

  /** Control lines are the driver's, never the event log's. True when the line was one. */
  private onControl(line: unknown): boolean {
    if (!isObject(line)) return false;
    if (line.type === "control_response") {
      const r = isObject(line.response) ? line.response : {};
      const resolve = this.pending.get(String(r.request_id));
      resolve?.(r.subtype === "success" && isObject(r.response) ? r.response : undefined);
      return true;
    }
    if (line.type === "control_request") {
      // Nothing Claude asks the host for is supported (permissions, hooks and MCP stay in Claude).
      this.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: line.request_id,
          error: "Not supported by this host",
        },
      }).catch(() => {});
      return true;
    }
    if (line.type === "system" && line.subtype === "commands_changed") {
      // The spike never saw it fire; the runtime reads `commands()` once per start, so a later change isn't stored.
      const list = commandsOf(line, this.log);
      if (list) this.commandList = Promise.resolve(list);
    }
    return false;
  }

  commands(): Promise<Command[] | undefined> {
    return this.commandList;
  }

  raw(text: string): Promise<void> {
    return this.write({ type: "user", message: { role: "user", content: text } });
  }

  private push(e: HarnessEvent, line: number) {
    this.lines.set(e, line);
    this.events.push(e);
  }

  /** The stdout line an event delivered by this process came from (U3 §11.2). */
  lineOf(event: object): number | undefined {
    return this.lines.get(event);
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
