import type { AgentRuntimeSpec } from "../types.ts";

export interface TransportExit {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started at all (e.g. the binary is missing). */
  spawnError?: { code?: string; message: string };
}

/** The byte pipe to one Claude process, wherever it runs. ClaudeProcess owns the protocol on top of it. */
export interface Transport {
  readonly pid: number | undefined;
  /** Writes one line (a newline is appended). Rejects with ProcessNotRunningError after end/exit. */
  write(line: string): Promise<void>;
  /** stdin EOF. */
  endInput(): void;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Resolves after the process is gone and stdout/stderr have been drained into the iterables. */
  readonly exit: Promise<TransportExit>;
  /** SIGTERM-equivalent. False when it could not signal. */
  terminate(): Promise<boolean>;
  /** SIGKILL-equivalent. */
  forceKill(): Promise<void>;
}

export type TransportFactory = (spec: AgentRuntimeSpec, args: string[]) => Transport;
