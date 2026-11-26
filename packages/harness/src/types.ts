import type { Command, Envelope, HarnessEvent, MessageKind } from "@open-factory/shared";
import type { LiveEvent } from "./claude/live.ts";

export interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface AgentRuntimeSpec {
  agentId: string;
  ref: string;
  cwd: string;
  /** The complete child env. Nothing from process.env is merged in. */
  env: Record<string, string>;
  claudeBin: string;
  runtime: "local" | "docker";
  model?: string;
  effort?: string;
  permissionMode: "auto" | "bypass";
  mounts: Mount[];
  /** Set by the server for Docker starts. */
  docker?: { containerId: string; claudeBin: string };
}

export interface FactoryMessage {
  id: string;
  from: string;
  fromKind: "human" | "agent" | "factory";
  kind: MessageKind;
  /** The recipients of a `kind: "message"`, as `@handle`s; rendered as the envelope's `to`. */
  to?: string[];
  urgent: boolean;
  /** Already escaped by groupEnvelopes (single/merge); renderEnvelopes writes it as given. */
  body: string;
  taskKey?: string;
  taskTitle?: string;
  commentId?: string;
  scheduleKey?: string;
  by?: string;
  due?: string;
  firings?: number;
  late?: boolean;
  ids?: string[];
  about?: string;
  /** A report's `member_update`: the requests of its turn when it wrote the text; rendered as `re` and `re_from`. */
  re?: Envelope["re"];
  /** The raw, unescaped bodies (for the UI). */
  parts: Envelope["parts"];
  fact?: string;
  subject?: Envelope["subject"];
  /** U3 §13.2: the sender's optimistic-row id, for the UI only; never rendered into the model's text. */
  clientMessageId?: string;
  /** U3 §13.5: the message's confirmed uploads, for the UI only; the model reads the body's `[attached: …]` lines. */
  attachments?: Envelope["attachments"];
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  timedOut?: boolean;
}

export interface HarnessProcess {
  readonly pid: number | undefined;
  /** One user turn. Resolves on the write callback; rejects with ProcessNotRunningError or the write error. */
  send(messages: FactoryMessage[]): Promise<void>;
  control(cmd: "compact" | "clear" | "interrupt", arg?: string): Promise<void>;
  /**
   * U3 §13.3: the command list from this process's `initialize`; undefined on an error or after 5 s. Never blocks a
   * send, and never enters the event log.
   */
  commands?(): Promise<Command[] | undefined>;
  /** The Claude Code version `initialize` reported, once it answered. */
  readonly claudeCodeVersion?: string | undefined;
  /** I1 §5.1: writes `text` as one user line, no envelope. The caller classifies and neutralises it. */
  raw?(text: string): Promise<void>;
  stop(opts?: { graceMs?: number; termWaitMs?: number }): Promise<ExitInfo>;
  /** SIGKILL-equivalent, for a process that outlived stop(). */
  forceKill(): Promise<void>;
  /** Ends after `exited`. */
  events: AsyncIterable<HarnessEvent>;
  /** Partial-message events (U3 §11.1), never persisted. Drivers without streaming leave it out. */
  live?: AsyncIterable<LiveEvent>;
  /** The stdout line an event from `events` came from, for ordering against `live` (U3 §11.2). */
  lineOf?(event: object): number | undefined;
}

export interface HarnessDriver {
  start(spec: AgentRuntimeSpec, opts: { resumeSessionId?: string }): HarnessProcess;
}

export class ProcessNotRunningError extends Error {
  constructor() {
    super("The agent process is not running");
    this.name = "ProcessNotRunningError";
  }
}
