import {
  type AgentRuntimeSpec,
  AsyncQueue,
  type ExitInfo,
  type FactoryMessage,
  type HarnessDriver,
  type HarnessProcess,
  ProcessNotRunningError,
} from "@open-factory/harness";
import type { HarnessEvent } from "@open-factory/shared";

export type Write =
  | { kind: "send"; messages: FactoryMessage[] }
  | { kind: "control"; cmd: string; arg?: string };

export class FakeProcess implements HarnessProcess {
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly writes: Write[] = [];
  failWrites = false;
  private done = false;
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

  emit(...evs: HarnessEvent[]) {
    for (const e of evs) this.events.push(e);
  }
  /** Unexpected exit. */
  exit(code = 1, stderrTail = "") {
    if (this.done) return;
    this.done = true;
    this.events.push({ type: "exited", code, signal: null, stderrTail, expected: false });
    this.events.end();
  }
  async send(messages: FactoryMessage[]) {
    if (this.done || this.failWrites) throw new ProcessNotRunningError();
    this.writes.push({ kind: "send", messages });
  }
  async control(cmd: "compact" | "clear" | "interrupt", arg?: string) {
    if (this.done || this.failWrites) throw new ProcessNotRunningError();
    this.writes.push({ kind: "control", cmd, ...(arg ? { arg } : {}) });
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
  async stop(): Promise<ExitInfo> {
    this.stopped = true;
    if (this.holdStop) await this.released;
    if (!this.done && this.emitExitOnStop) {
      this.done = true;
      this.events.push({ type: "exited", code: 0, signal: null, stderrTail: "", expected: true });
      this.events.end();
    }
    return this.stopResult ?? { code: 0, signal: null };
  }
}

export class FakeDriver implements HarnessDriver {
  readonly starts: FakeProcess[] = [];
  start(spec: AgentRuntimeSpec, opts: { resumeSessionId?: string }) {
    const p = new FakeProcess(spec, opts);
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
  background: (tasks: { taskId: string; ambient?: boolean }[]): HarnessEvent => ({
    type: "background_tasks",
    tasks: tasks.map((t) => ({ taskType: "local_bash", ...t })),
  }),
  taskFinished: (taskId: string): HarnessEvent => ({
    type: "background_task_finished",
    taskId,
    status: "completed",
    summary: "",
  }),
};
