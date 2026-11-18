import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AgentRow, MessageRow } from "@open-factory/db";
import type {
  AgentRuntimeSpec,
  FactoryMessage,
  HarnessDriver,
  HarnessProcess,
} from "@open-factory/harness";
import type {
  AgentStatus,
  AgentStatusFrame,
  AgentSummary,
  AnyEvent,
  HarnessEvent,
  QueueItem,
} from "@open-factory/shared";
import type { Config } from "../config.ts";
import { AgentStartError, NoOpenTurnError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, Tx } from "./event-store.ts";
import { agentConfigDir, buildRuntimeSpec, resolveClaudeToken } from "./runtime-spec.ts";
import { SerialQueue } from "./serial-queue.ts";

export interface RuntimeLog {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RuntimeDeps {
  agent: AgentRow;
  store: EventStore;
  bus: EventBus;
  driver: HarnessDriver;
  config: Config;
  log: RuntimeLog;
  holdTimeoutMs?: number;
  serverEnv?: NodeJS.ProcessEnv;
  /** Called with the spec of the first start (AgentRuntimes uses it for the one-time version check). */
  onFirstStart?: (spec: AgentRuntimeSpec) => void;
}

type MessageEntry = { kind: "message"; row: MessageRow; fromHandle: string };
type CompactEntry = { kind: "compact"; id: string; focus?: string; by: string; createdAt: Date };
type Entry = MessageEntry | CompactEntry;

const toFactory = (e: MessageEntry): FactoryMessage => ({
  id: e.row.id,
  from: `@${e.fromHandle}`,
  kind: "message",
  urgent: e.row.urgent,
  body: e.row.body,
});

export class AgentRuntime {
  readonly agent: AgentRow;
  private readonly jobs = new SerialQueue();
  private proc: HarnessProcess | undefined;
  private deadProc: HarnessProcess | undefined;
  private started = false; // session_started seen for this process
  private openTurnId: string | undefined;
  private lastUsage: Extract<HarnessEvent, { type: "usage" }> | undefined;
  private queue: Entry[] = [];
  private inFlight: MessageEntry[][] = []; // written, waiting for session_started
  private awaiting: string[][] = []; // written with no open turn, waiting for a user-initiated turn_end
  private compactInFlight = false;
  private hold: ReturnType<typeof setTimeout> | undefined;
  private errored: boolean;
  private lastError: string | undefined;
  private lastStatusJson = "";
  private firstStartDone = false;
  private submitted = 0;

  constructor(private readonly d: RuntimeDeps) {
    this.agent = d.agent;
    this.errored = d.agent.status === "errored";
  }

  async init() {
    const pending = await this.d.store.pendingQueue(this.agent.id);
    this.queue = pending.map(({ fromHandle, ...row }) => ({ kind: "message", row, fromHandle }));
  }

  // ---------- public API (each runs as a job) ----------

  async sendMessage(m: {
    fromUserId: string;
    fromHandle: string;
    body: string;
    urgent: boolean;
  }): Promise<QueueItem> {
    const row = await this.d.store.createMessage({
      fromUserId: m.fromUserId,
      toAgentId: this.agent.id,
      body: m.body,
      urgent: m.urgent,
    });
    const entry: MessageEntry = { kind: "message", row, fromHandle: m.fromHandle };
    return this.apiJob(async () => {
      this.queue.push(entry);
      this.publishQueue();
      await this.ensureStarted();
      if (m.urgent) await this.urgentInterrupt(m.fromHandle);
      await this.flush();
      return this.itemOf(entry);
    });
  }

  async compact(c: { focus?: string; byHandle: string }): Promise<QueueItem> {
    const entry: CompactEntry = {
      kind: "compact",
      id: randomUUID(),
      by: c.byHandle,
      createdAt: new Date(),
      ...(c.focus ? { focus: c.focus } : {}),
    };
    return this.apiJob(async () => {
      this.queue.push(entry);
      this.publishQueue();
      await this.ensureStarted();
      await this.flush();
      return this.itemOf(entry);
    });
  }

  async interrupt(c: { byHandle: string }): Promise<void> {
    return this.apiJob(async () => {
      if (!this.proc || !this.openTurnId) throw new NoOpenTurnError();
      await this.proc.control("interrupt");
      await this.append(this.openTurnId, {
        type: "control",
        cmd: "interrupt",
        by: `@${c.byHandle}`,
      });
    });
  }

  summary(): AgentSummary {
    return {
      slug: this.agent.slug,
      displayName: this.agent.displayName,
      description: this.agent.description,
      status: this.status(),
      turnOpen: Boolean(this.openTurnId),
      runtime: "local",
      ...(this.lastError && this.errored ? { lastError: this.lastError } : {}),
    };
  }

  statusFrame(): AgentStatusFrame {
    const s = this.summary();
    return {
      type: "agent_status",
      agent: s.slug,
      status: s.status,
      turnOpen: s.turnOpen,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  }

  queueItems(): QueueItem[] {
    return this.queue.map((e) => this.itemOf(e));
  }

  /** Graceful stop (server shutdown, tests). Waits until the exit is persisted. */
  async stop(opts?: { graceMs?: number; termWaitMs?: number }) {
    const p = this.proc;
    if (p) await p.stop(opts);
    await this.settled();
  }

  /** All queued jobs, including events already emitted by the process, have run. */
  async settled() {
    for (;;) {
      const before = this.submitted;
      await new Promise((r) => setImmediate(r));
      await this.jobs.idle();
      await new Promise((r) => setImmediate(r));
      if (this.submitted === before) return;
    }
  }

  /** Every job goes through here, so `settled()` can tell when no new job was submitted. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    this.submitted += 1;
    return this.jobs.run(job);
  }

  /**
   * An API job. An unexpected failure (a DB write after a stdin write, say) gets the same treatment as one in
   * an event job (spec §11): stop the process and mark errored, then reject the API call.
   */
  private apiJob<T>(job: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      try {
        return await job();
      } catch (err) {
        if (!(err instanceof AgentStartError || err instanceof NoOpenTurnError) && this.proc)
          await this.onJobFailure(this.proc, err);
        throw err;
      }
    });
  }

  // ---------- internals ----------

  private status(): AgentStatus {
    if (this.errored) return "errored";
    if (!this.proc) return "hibernated";
    if (!this.started || this.openTurnId || this.awaiting.length || this.compactInFlight)
      return "working";
    return "idle";
  }

  private itemOf(e: Entry): QueueItem {
    return e.kind === "message"
      ? {
          id: e.row.id,
          kind: "message",
          body: e.row.body,
          urgent: e.row.urgent,
          from: `@${e.fromHandle}`,
          createdAt: e.row.createdAt.toISOString(),
        }
      : {
          id: e.id,
          kind: "compact",
          from: `@${e.by}`,
          createdAt: e.createdAt.toISOString(),
          ...(e.focus ? { focus: e.focus } : {}),
        };
  }

  private async append(turnId: string | null | undefined, event: AnyEvent, tx?: Tx) {
    const dto = await this.d.store.append(this.agent.id, turnId ?? null, event, tx);
    if (!tx)
      this.d.bus.publish(this.agent.slug, {
        type: "session_event",
        agent: this.agent.slug,
        event: dto,
      });
    return dto;
  }

  private publishStatus() {
    const frame = this.statusFrame();
    const json = JSON.stringify(frame);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.d.bus.publishAll(frame);
  }

  private publishQueue() {
    this.d.bus.publish(this.agent.slug, {
      type: "queue",
      agent: this.agent.slug,
      items: this.queueItems(),
    });
  }

  private async setErrored(message: string) {
    this.errored = true;
    this.lastError = message;
    await this.d.store.setStatus(this.agent.id, "errored");
  }

  /** Only called from API jobs (send, compact): a flush never restarts a dead process. */
  private async ensureStarted() {
    if (this.proc) return;
    const token = resolveClaudeToken(this.d.config);
    if (!token) {
      const message = "Set CLAUDE_CODE_OAUTH_TOKEN to run agents";
      await this.append(null, { type: "error", source: "spawn", message });
      await this.setErrored(message);
      this.publishStatus();
      throw new AgentStartError(message);
    }
    await mkdir(agentConfigDir(this.d.config, this.agent.slug), { recursive: true });
    const spec = buildRuntimeSpec(this.agent, this.d.config, token, this.d.serverEnv);
    if (!this.firstStartDone) {
      this.firstStartDone = true;
      this.d.onFirstStart?.(spec);
    }
    const row = await this.d.store.agentById(this.agent.id);
    const resumeSessionId = row?.sessionId ?? undefined;
    const proc = this.d.driver.start(spec, resumeSessionId ? { resumeSessionId } : {});
    this.proc = proc;
    this.started = false;
    // Pump first: its jobs queue behind this one, and if the append below fails the stop's `exited` is still consumed.
    void this.pump(proc);
    await this.append(null, { type: "process_started", resumed: Boolean(resumeSessionId) });
    this.publishStatus();
  }

  private async pump(proc: HarnessProcess) {
    for await (const e of proc.events) {
      // The failure handling runs inside the same job, so it is ordered before the next event and `settled()` covers it.
      await this.run(async () => {
        try {
          await this.onEvent(proc, e);
        } catch (err) {
          await this.onJobFailure(proc, err);
        }
      });
    }
  }

  private async onJobFailure(proc: HarnessProcess, err: unknown) {
    this.d.log.error(
      { err, agent: this.agent.slug },
      "agent event handling failed; stopping the process",
    );
    if (this.deadProc === proc) {
      this.publishStatus(); // e.g. recording its exit failed: the in-memory state was still reset
      return;
    }
    this.deadProc = proc;
    void proc.stop({ graceMs: 0 });
    await this.setErrored("Internal error while recording the session").catch(() => {
      this.errored = true; // the DB may be the thing that failed; keep the in-memory truth
    });
    this.publishStatus();
  }

  private async onEvent(proc: HarnessProcess, e: HarnessEvent) {
    if (this.deadProc === proc && e.type !== "exited") return;
    if (proc !== this.proc && this.deadProc !== proc) return;
    switch (e.type) {
      case "session_started": {
        this.started = true;
        const row = await this.d.store.agentById(this.agent.id);
        if (!row?.sessionId) await this.d.store.setSessionId(this.agent.id, e.sessionId);
        else if (row.sessionId !== e.sessionId)
          this.d.log.error(
            { agent: this.agent.slug, stored: row.sessionId, got: e.sessionId },
            "session id changed",
          );
        if (this.errored) {
          this.errored = false;
          this.lastError = undefined;
          await this.d.store.setStatus(this.agent.id, "hibernated");
        }
        await this.append(null, e);
        for (const batch of this.inFlight.splice(0))
          await this.d.store.markDelivered(batch.map((m) => m.row.id));
        break;
      }
      case "turn_started":
        this.openTurnId = await this.d.store.openTurn(this.agent.id);
        this.lastUsage = undefined;
        await this.append(this.openTurnId, e);
        break;
      case "usage":
        this.lastUsage = e;
        await this.append(this.openTurnId, e);
        break;
      case "turn_end": {
        const turnId = this.openTurnId;
        await this.append(turnId, e);
        if (turnId) {
          await this.d.store.closeTurn(turnId, {
            isError: e.isError,
            terminalReason: e.terminalReason,
            originKind: e.originKind,
            usage: this.lastUsage,
          });
          if (!e.originKind && this.awaiting.length) {
            await this.d.store.setDeliveredTurn(this.awaiting.flat(), turnId);
            this.awaiting = [];
          }
        }
        this.openTurnId = undefined;
        if (e.command === "compact") this.compactInFlight = false;
        this.releaseHold();
        await this.flush();
        break;
      }
      case "error":
        await this.append(this.openTurnId, e);
        if (!this.started && (e.source === "resume" || e.source === "spawn")) {
          await this.setErrored(e.message);
          void proc.stop({ graceMs: 1000 });
        }
        break;
      case "exited":
        await this.onExited(proc, e);
        break;
      default:
        await this.append(this.openTurnId, e);
    }
    this.publishStatus();
  }

  private async onExited(proc: HarnessProcess, e: Extract<HarnessEvent, { type: "exited" }>) {
    // Reset the in-memory state first, so the runtime can restart even if recording the exit fails (DB down).
    const rolledBack = this.inFlight.splice(0);
    const openTurnId = this.openTurnId;
    const usage = this.lastUsage;
    // Unconfirmed batches re-enter the head in their original order (spec §8.3 rule 7).
    this.queue.unshift(...rolledBack.flat());
    this.openTurnId = undefined;
    this.releaseHold();
    this.compactInFlight = false;
    this.awaiting = [];
    if (this.proc === proc) this.proc = undefined;
    this.started = false;
    const unexpected = !e.expected && !this.errored;
    if (unexpected) {
      this.errored = true;
      this.lastError =
        e.code !== null
          ? `Exited unexpectedly (code ${e.code})`
          : `Exited unexpectedly (${e.signal ?? "unknown"})`;
    }
    try {
      for (const batch of rolledBack) {
        const ids = batch.map((m) => m.row.id);
        await this.d.store.markPending(ids);
        await this.append(null, {
          type: "delivery_failed",
          messageIds: ids,
          reason: e.expected
            ? "stopped before the session started"
            : "the agent process exited before the session started",
        });
      }
      if (openTurnId)
        await this.d.store.closeTurn(openTurnId, {
          isError: !e.expected,
          terminalReason: e.expected ? "process_stopped" : "process_exited",
          usage,
        });
      await this.append(null, e);
      if (unexpected) await this.d.store.setStatus(this.agent.id, "errored");
    } finally {
      this.publishQueue();
    }
  }

  private async urgentInterrupt(by: string) {
    // idle → normal send; hold active → no second interrupt; a compact in flight is never interrupted (it
    // waits behind the barrier instead)
    if (!this.proc || !this.openTurnId || this.hold || this.compactInFlight) return;
    await this.proc.control("interrupt");
    const hold = setTimeout(() => {
      this.d.log.warn(
        { agent: this.agent.slug },
        "no result within the urgent hold timeout; sending anyway",
      );
      void this.run(async () => {
        if (this.hold !== hold) return; // already released (turn_end or exited); never release a newer hold
        this.releaseHold();
        try {
          await this.flush();
        } catch (err) {
          if (this.proc) await this.onJobFailure(this.proc, err);
          else
            this.d.log.error({ err, agent: this.agent.slug }, "flush after the urgent hold failed");
        }
        this.publishStatus();
      });
    }, this.d.holdTimeoutMs ?? 10_000);
    this.hold = hold;
    await this.append(this.openTurnId, { type: "control", cmd: "interrupt", by: `@${by}` });
  }

  private releaseHold() {
    if (this.hold) clearTimeout(this.hold);
    this.hold = undefined;
  }

  /** Strict FIFO from the head while allowed (spec §8.3). Never starts a process. */
  private async flush() {
    while (this.proc && !this.hold && !this.compactInFlight && this.queue.length) {
      const head = this.queue[0];
      if (!head) break;
      if (head.kind === "compact") {
        if (this.openTurnId || this.awaiting.length || this.inFlight.length) break;
        this.queue.shift();
        try {
          await this.proc.control("compact", head.focus);
        } catch {
          this.queue.unshift(head);
          break;
        }
        this.compactInFlight = true;
        await this.append(null, {
          type: "control",
          cmd: "compact",
          by: `@${head.by}`,
          ...(head.focus ? { arg: head.focus } : {}),
        });
        this.publishQueue();
        break;
      }
      const batch: MessageEntry[] = [];
      while (this.queue[0]?.kind === "message") batch.push(this.queue.shift() as MessageEntry);
      if (!(await this.writeBatch(batch))) break; // a rejected write leaves the batch at the head: stop, don't spin
    }
  }

  /** False when the write was rejected (the batch is back at the head of the queue). */
  private async writeBatch(batch: MessageEntry[]): Promise<boolean> {
    const proc = this.proc;
    if (!proc) {
      this.queue.unshift(...batch);
      return false;
    }
    const ids = batch.map((m) => m.row.id);
    try {
      await proc.send(batch.map(toFactory));
    } catch (err) {
      this.queue.unshift(...batch);
      await this.append(null, {
        type: "delivery_failed",
        messageIds: ids,
        reason: err instanceof Error ? err.message : "write failed",
      });
      this.publishQueue();
      return false;
    }
    const turnAtWrite = this.openTurnId;
    let dto: Awaited<ReturnType<EventStore["append"]>>;
    try {
      dto = await this.d.store.transaction(async (tx) => {
        const out = await this.d.store.append(
          this.agent.id,
          turnAtWrite ?? null,
          { type: "message_in", messages: batch.map(toFactory) },
          tx,
        );
        if (this.started) await this.d.store.markDelivered(ids, tx);
        if (turnAtWrite) await this.d.store.setDeliveredTurn(ids, turnAtWrite, tx);
        return out;
      });
    } catch (err) {
      // Claude has the batch but nothing recorded it: keep the rows pending at the head (re-sent on the next start,
      // so it may be seen twice) and let the caller stop the process (spec §11).
      this.queue.unshift(...batch);
      throw err;
    }
    this.d.bus.publish(this.agent.slug, {
      type: "session_event",
      agent: this.agent.slug,
      event: dto,
    });
    if (!this.started) this.inFlight.push(batch);
    if (!turnAtWrite) this.awaiting.push(ids);
    this.publishQueue();
    return true;
  }
}
