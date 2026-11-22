import {
  type AgentRuntimeSpec,
  AsyncQueue,
  type ExitInfo,
  type FactoryMessage,
  type HarnessDriver,
  type HarnessProcess,
  type LiveEvent,
  ProcessNotRunningError,
} from "@open-factory/harness";
import type { Command, HarnessEvent } from "@open-factory/shared";

export type Write =
  | { kind: "send"; messages: FactoryMessage[] }
  | { kind: "control"; cmd: string; arg?: string }
  | { kind: "command"; text: string };

export class FakeProcess implements HarnessProcess {
  readonly events = new AsyncQueue<HarnessEvent>();
  /** Optional on HarnessProcess (U3 §11.1); tests push partial-message events with `emitLive`. */
  readonly live = new AsyncQueue<LiveEvent>();
  readonly writes: Write[] = [];
  failWrites = false;
  private done = false;
  /** Its `exited` was emitted: the process is gone. */
  get exited() {
    return this.done;
  }
  readonly pid = 4242;
  constructor(
    readonly spec: AgentRuntimeSpec,
    readonly opts: { resumeSessionId?: string },
  ) {}

  get sent() {
    return this.writes
      .filter((w) => w.kind === "send")
      .map((w) => (w.kind === "send" ? w.messages : []));
  }
  get controls() {
    return this.writes.filter((w) => w.kind === "control");
  }

  /** Stdout line numbers of events emitted with `emitAt` (U3 §11.2); others have none. */
  private readonly lines = new WeakMap<object, number>();
  private lastLine = 0;
  lineOf(event: object): number | undefined {
    return this.lines.get(event);
  }

  emit(...evs: HarnessEvent[]) {
    for (const e of evs) this.events.push(e);
  }
  /** Emits events as if read from stdout line `line`. */
  emitAt(line: number, ...evs: HarnessEvent[]) {
    this.lastLine = Math.max(this.lastLine, line);
    for (const e of evs) {
      this.lines.set(e, line);
      this.events.push(e);
    }
  }
  emitLive(...evs: LiveEvent[]) {
    for (const e of evs) {
      this.lastLine = Math.max(this.lastLine, e.line);
      this.live.push(e);
    }
  }
  /** The `exited` event, on the line after the last one (as ClaudeProcess stamps it). */
  private exitEvent(e: HarnessEvent) {
    this.lines.set(e, this.lastLine + 1);
    return e;
  }
  /** Unexpected exit. */
  exit(code = 1, stderrTail = "") {
    if (this.done) return;
    this.done = true;
    this.events.push(
      this.exitEvent({ type: "exited", code, signal: null, stderrTail, expected: false }),
    );
    this.events.end();
    this.live.end();
  }
  async send(messages: FactoryMessage[]) {
    if (this.done || this.failWrites) throw new ProcessNotRunningError();
    this.writes.push({ kind: "send", messages });
  }
  async control(cmd: "compact" | "clear" | "interrupt", arg?: string) {
    if (this.done || this.failWrites) throw new ProcessNotRunningError();
    this.writes.push({ kind: "control", cmd, ...(arg ? { arg } : {}) });
  }
  /** What `commands()` resolves with (U3 §13.3): set before the start, or undefined (no list). */
  commandList: Command[] | undefined;
  claudeCodeVersion: string | undefined = "2.1.327";
  async commands() {
    return this.commandList;
  }
  async command(text: string) {
    if (this.done || this.failWrites) throw new ProcessNotRunningError();
    this.writes.push({ kind: "command", text });
  }
  /** Set by the first `stop()` call. */
  stopped = false;
  /** When true, `stop()` waits for `releaseStop()` before it emits `exited` (a stop grace in progress). */
  holdStop = false;
  /** Overrides what `stop()` resolves with (e.g. `{ timedOut: true }`). */
  stopResult: ExitInfo | undefined;
  /** When false, `stop()` never emits `exited` (a process that didn't stop). */
  emitExitOnStop = true;
  private release: (() => void) | undefined;
  private readonly released = new Promise<void>((r) => {
    this.release = r;
  });
  releaseStop() {
    this.release?.();
  }
  forceKilled = false;
  forceKill = async () => {
    this.forceKilled = true;
    this.exit(137);
  };
  async stop(): Promise<ExitInfo> {
    this.stopped = true;
    if (this.holdStop) await this.released;
    if (!this.done && this.emitExitOnStop) {
      this.done = true;
      this.events.push(
        this.exitEvent({ type: "exited", code: 0, signal: null, stderrTail: "", expected: true }),
      );
      this.events.end();
      this.live.end();
    }
    return this.stopResult ?? { code: 0, signal: null };
  }
}

export class FakeDriver implements HarnessDriver {
  readonly starts: FakeProcess[] = [];
  /** Each new process's `commands()` answer (U3 §13.3); undefined = no list. */
  commandList: Command[] | undefined;
  start(spec: AgentRuntimeSpec, opts: { resumeSessionId?: string }) {
    const p = new FakeProcess(spec, opts);
    p.commandList = this.commandList;
    this.starts.push(p);
    return p;
  }
  get last(): FakeProcess {
    const p = this.starts.at(-1);
    if (!p) throw new Error("no process started");
    return p;
  }
}

/** Shorthands for scripted turns. */
export const ev = {
  session: (sessionId = "sess-1"): HarnessEvent => ({
    type: "session_started",
    sessionId,
    model: "m",
    cwd: "/w",
    claudeCodeVersion: "2.1.327",
  }),
  turn: (): HarnessEvent => ({ type: "turn_started" }),
  text: (text: string): HarnessEvent => ({ type: "assistant_text", text }),
  usage: (): HarnessEvent => ({
    type: "usage",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    durationMs: 1,
    numTurns: 1,
  }),
  end: (over: Partial<Extract<HarnessEvent, { type: "turn_end" }>> = {}): HarnessEvent => ({
    type: "turn_end",
    isError: false,
    terminalReason: "completed",
    numTurns: 1,
    ...over,
  }),
  /** A whole first turn: session_started, turn_started, usage, turn_end. */
  fullTurn: (sessionId = "sess-1"): HarnessEvent[] => [
    ev.session(sessionId),
    ev.turn(),
    ev.usage(),
    ev.end(),
  ],
  background: (
    tasks: { taskId: string; ambient?: boolean; description?: string }[],
  ): HarnessEvent => ({
    type: "background_tasks",
    tasks: tasks.map((t) => ({ taskType: "local_bash", ...t })),
  }),
  taskFinished: (taskId: string): HarnessEvent => ({
    type: "background_task_finished",
    taskId,
    status: "completed",
    summary: "",
  }),
  cron: (
    cronId: string,
    o: { recurring?: boolean; humanSchedule?: string; inMs?: number } = {},
  ): HarnessEvent => ({
    type: "cron_created",
    cronId,
    recurring: o.recurring ?? true,
    humanSchedule: o.humanSchedule ?? "every 5 minutes",
    nextFireAt: Date.now() + (o.inMs ?? 300_000),
  }),
};
