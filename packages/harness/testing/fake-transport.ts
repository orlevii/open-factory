import { AsyncQueue } from "../src/async-queue.ts";
import type { Transport, TransportExit } from "../src/transport/types.ts";
import { ProcessNotRunningError } from "../src/types.ts";

/** A scripted Transport: push stdout lines, control the exit, and count terminate/endInput calls. */
export class FakeTransport implements Transport {
  readonly stdout = new AsyncQueue<string>();
  readonly stderr = new AsyncQueue<string>();
  readonly writes: string[] = [];
  endInputCalls = 0;
  terminateCalls = 0;
  forceKillCalls = 0;
  pid: number | undefined = 4343;
  private done = false;
  private resolveExit!: (e: TransportExit) => void;
  readonly exit = new Promise<TransportExit>((r) => {
    this.resolveExit = r;
  });

  constructor(private readonly o: { terminateResult?: boolean; exitOnEndInput?: number } = {}) {}

  async write(line: string) {
    if (this.done || this.endInputCalls > 0) throw new ProcessNotRunningError();
    this.writes.push(line);
  }
  endInput() {
    this.endInputCalls++;
    if (this.o.exitOnEndInput !== undefined) this.exitWith(this.o.exitOnEndInput);
  }
  async terminate() {
    this.terminateCalls++;
    return this.o.terminateResult ?? true;
  }
  async forceKill() {
    this.forceKillCalls++;
    this.exitWith(null, "SIGKILL");
  }
  emitStdout(...lines: string[]) {
    for (const l of lines) this.stdout.push(l);
  }
  emitStderr(...lines: string[]) {
    for (const l of lines) this.stderr.push(l);
  }
  exitWith(
    code: number | null,
    signal: string | null = null,
    spawnError?: TransportExit["spawnError"],
  ) {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ code, signal, ...(spawnError ? { spawnError } : {}) });
  }
}
