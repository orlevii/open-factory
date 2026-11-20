import type { HarnessEvent } from "@open-factory/shared";

export interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface AgentRuntimeSpec {
  agentId: string;
  slug: string;
  cwd: string;
  /** The complete child env. Nothing from process.env is merged in. */
  env: Record<string, string>;
  claudeBin: string;
  runtime: "local" | "docker";
  model?: string;
  effort?: string;
  permissionMode: "auto" | "bypass";
  mounts: Mount[];
}

export interface FactoryMessage {
  id: string;
  from: string;
  kind: "message";
  urgent: boolean;
  body: string;
  taskKey?: string;
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
  stop(opts?: { graceMs?: number; termWaitMs?: number }): Promise<ExitInfo>;
  /** Ends after `exited`. */
  events: AsyncIterable<HarnessEvent>;
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
