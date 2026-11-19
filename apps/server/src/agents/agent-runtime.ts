import { randomUUID } from "node:crypto";
import type { AgentRow, MessageRow, RuntimeJournal } from "@open-factory/db";
import {
  type AgentRuntimeSpec,
  type FactoryMessage,
  type HarnessDriver,
  type HarnessProcess,
  ProcessNotRunningError,
} from "@open-factory/harness";
import {
  type AgentStatus,
  type AgentStatusFrame,
  type AnyEvent,
  type HarnessEvent,
  type QueueItem,
  statusOf,
  type WaitingOn,
} from "@open-factory/shared";
import { type SlotPort, unlimitedSlots, type WakeReason } from "../supervisor/slots.ts";
import { AgentArchivedError, AgentStartError, NoOpenTurnError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, Tx } from "./event-store.ts";
import { type NoticeType, notices } from "./notices.ts";
import { SerialQueue } from "./serial-queue.ts";
import type { PrepareStart } from "./start.ts";

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
  /** Builds the spec for a process start. It takes the agent's slug lock itself: never call it while holding that lock. */
  prepareStart: PrepareStart;
  log: RuntimeLog;
  holdTimeoutMs?: number;
  /** Called with the spec of the first start (AgentRuntimes uses it for the one-time version check). */
  onFirstStart?: (spec: AgentRuntimeSpec) => void;
  /** The Supervisor's slot port (spec §5.2); defaults to unlimited slots. */
  slots?: SlotPort;
  /** Whether the agent's credential is rate-limit paused (spec §6.3, D1); defaults to never. */
  credentialPaused?: () => boolean;
}

export type HibernateReason =
  | "warm_window"
  | "freed_slot"
  | "apply_changes"
  | "shutdown"
  | "archived";

/** The live non-ambient tasks and crons a stop would kill (spec §9.4). */
export type LostWork = {
  tasks: { taskId: string; description: string }[];
  crons: { cronId: string; humanSchedule: string }[];
};

/** What the `exited` job must do, recorded when a deliberate stop begins (spec §5.5). */
export type AfterExit =
  | { kind: "hibernate"; reason: HibernateReason; lost: LostWork }
  | { kind: "restart"; by: string }
  | { kind: "failed_start" } // S3's stop after a spawn or resume failure
  | { kind: "internal" }; // S3's onJobFailure stop

/** A queued message row; `fromHandle` is null for a `@factory` system notice (row.kind === "system"). */
type MessageEntry = { kind: "message"; row: MessageRow; fromHandle: string | null };
type CompactEntry = { kind: "compact"; id: string; focus?: string; by: string; createdAt: Date };
type Entry = MessageEntry | CompactEntry;

const isNotice = (e: Entry): e is MessageEntry => e.kind === "message" && e.row.kind === "system";

/** The only reasons that wake an errored agent (spec §5.2, §9.2); `message` is a human's (notices never wake). */
const ERRORED_WAKES: ReadonlySet<WakeReason> = new Set([
  "crash_recovery",
  "restart",
  "reset",
  "message",
]);

const fromOf = (e: MessageEntry): string => {
  if (e.row.kind === "system") return "@factory";
  if (e.fromHandle === null) throw new Error(`message ${e.row.id} has no sender`);
  return `@${e.fromHandle}`;
};

/** The owed-notification bound (spec §6.1). */
const OWED_BOUND_MS = 30_000;
/** Claude expires an in-session cron 7 days after it was created (spec §6.2). */
const CRON_EXPIRY_MS = 7 * 24 * 3_600_000;
const DEFAULT_WARM_WINDOW_MINUTES = 70;

type LiveTask = { ambient: boolean; description: string; startedAt: number };
type LiveCron = {
  recurring: boolean;
  humanSchedule: string;
  nextFireAt: number;
  createdAt: number;
};

const toFactory = (e: MessageEntry): FactoryMessage => ({
  id: e.row.id,
  from: fromOf(e),
  kind: e.row.kind === "system" ? "system" : "message",
  urgent: e.row.urgent,
  body: e.row.body,
});

export class AgentRuntime {
  agent: AgentRow;
  private readonly jobs = new SerialQueue();
  private proc: HarnessProcess | undefined;
  private deadProc: HarnessProcess | undefined;
  private started = false; // session_started seen for this process
  private starting = false; // a start is between its API job and the spawn (prepare may be waiting on the slug lock)
  private openTurnId: string | undefined;
  private lastUsage: Extract<HarnessEvent, { type: "usage" }> | undefined;
  private queue: Entry[] = [];
  private inFlight: MessageEntry[][] = []; // written, waiting for session_started
  private awaiting: string[][] = []; // written with no open turn, waiting for a user-initiated turn_end
  private compactInFlight = false;
  private hold: ReturnType<typeof setTimeout> | undefined;
  private errored: boolean;
  private archived: boolean;
  private lastError: string | undefined;
  private lastStatusJson = "";
  private firstStartDone = false;
  private submitted = 0;
  // Apply-restart (spec §13)
  private restartPending = false;
  private stopping = false; // a deliberate stop of the current process began: flush() writes nothing
  private stopsInProgress = 0; // stop() calls not yet returned: no process may be spawned meanwhile
  private afterExit: AfterExit | undefined; // the intent of the stop in progress, consumed by the `exited` job
  private noStart = false; // the closing latch (spec §5.6): never launch again
  private readonly slots: SlotPort;
  private failingProc: HarnessProcess | undefined; // a start that failed (spawn/resume error) and is being stopped
  private liveTasks = new Map<string, LiveTask>(); // startedAt = first seen in a `background_tasks` set
  private crons = new Map<string, LiveCron>(); // the live in-session crons (spec §6.2): pin the agent
  private owedNotifications = 0;
  private owedTimer: ReturnType<typeof setTimeout> | undefined;
  private warmTimer: ReturnType<typeof setTimeout> | undefined;
  private cronExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private cronExpiryAt: number | undefined;
  private wasHibernatable = false;
  private journalJson = "null"; // the tasks/crons part last written to runtime_journal
  /** The last turn end, delivery or start (spec §5.3: the least recently active is evicted first). */
  lastActivityAt = Date.now();

  constructor(private readonly d: RuntimeDeps) {
    this.agent = d.agent;
    this.errored = d.agent.status === "errored";
    this.archived = Boolean(d.agent.archivedAt);
    this.slots = d.slots ?? unlimitedSlots;
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
    return this.apiJob(async () => {
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      const row = await this.d.store.createMessage({
        fromUserId: m.fromUserId,
        toAgentId: this.agent.id,
        body: m.body,
        urgent: m.urgent,
      });
      const entry: MessageEntry = { kind: "message", row, fromHandle: m.fromHandle };
      this.queue.push(entry);
      this.publishQueue();
      await this.wakeInline("message");
      if (m.urgent) await this.urgentInterrupt(m.fromHandle);
      await this.flush();
      return this.itemOf(entry);
    });
  }

  /**
   * Adds (or refreshes) a `@factory` notice. Call inside a job. A new notice goes ahead of every non-notice entry
   * (older pending messages, rolled-back batches); a replaced pending one only changes its body. Starts nothing.
   */
  async addNotice(type: NoticeType, body: string) {
    const row = await this.d.store.createNotice(
      { toAgentId: this.agent.id, notice: type, body },
      this.inFlight.flat().map((e) => e.row.id),
    );
    const existing = this.queue.find(
      (e): e is MessageEntry => e.kind === "message" && e.row.id === row.id,
    );
    if (existing) existing.row = row;
    else {
      const at = this.queue.findIndex((e) => !isNotice(e));
      this.queue.splice(at === -1 ? this.queue.length : at, 0, {
        kind: "message",
        row,
        fromHandle: null,
      });
    }
    this.publishQueue();
  }

  /** `addNotice` as its own job, then a flush (never starts a process). */
  postNotice(type: NoticeType, body: string): Promise<void> {
    return this.apiJob(async () => {
      await this.addNotice(type, body);
      await this.flush();
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
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      this.queue.push(entry);
      this.publishQueue();
      await this.wakeInline("compact");
      await this.flush();
      return this.itemOf(entry);
    });
  }

  async interrupt(c: { byHandle: string }): Promise<void> {
    return this.apiJob(async () => {
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      if (!this.proc || !this.openTurnId) throw new NoOpenTurnError();
      try {
        await this.proc.control("interrupt");
      } catch (err) {
        // The process is going away and its `exited` is not processed yet: there is nothing to interrupt (409).
        if (err instanceof ProcessNotRunningError) throw new NoOpenTurnError();
        throw err;
      }
      await this.append(this.openTurnId, {
        type: "control",
        cmd: "interrupt",
        by: `@${c.byHandle}`,
      });
    });
  }

  /** Refreshes the row (renames, template-driven edits) and the archived flag. */
  async reload(): Promise<void> {
    await this.run(async () => {
      const r = await this.d.store.agentById(this.agent.id);
      if (r) {
        this.agent = r;
        this.archived = Boolean(r.archivedAt);
      }
      this.publishStatus();
    });
  }

  /**
   * Applies config changes at the next safe moment: stop the process gracefully and resume the same session on
   * the next start, whose prepareStart reloads everything from the DB. A no-op when no process is running.
   */
  async requestRestart(): Promise<void> {
    await this.run(async () => {
      // Not running (or already going away): the next start reads the new values anyway.
      if (
        this.proc &&
        this.proc !== this.deadProc &&
        this.proc !== this.failingProc &&
        !this.stopping
      ) {
        this.restartPending = true;
        this.maybeRestart();
      }
      this.publishStatus();
    });
  }

  /** Synchronous: the archive route calls it before it stops the process, so no new send gets in. */
  markArchived(): void {
    this.archived = true;
  }

  /** The closing latch (spec §5.6). Synchronous: a start already inside prepareStart re-checks it before the launch. */
  setNoStart(): void {
    this.noStart = true;
    this.updateWarmTimer();
    this.clearOwedBound();
  }

  /** The Supervisor's grant job: start with the slot it handed over, or give it back when no longer eligible. */
  grant(reason: WakeReason): Promise<void> {
    return this.run(async () => {
      if (this.proc) {
        // Never release here: the slot is held by the running process and its exit releases it.
        this.d.log.error({ agent: this.agent.slug, reason }, "grant for an agent that is running");
        return;
      }
      // The whole eligibility predicate again (spec §5.2): the grant was bookkeeping, this is the agent's own turn.
      if (
        this.noStart ||
        this.slots.closing() ||
        !this.acceptsWake(reason) ||
        !this.hasDeliverable() ||
        this.credentialPaused()
      ) {
        this.slots.release(this.agent.id);
        this.publishStatus();
        return;
      }
      await this.startAndFlush(reason, "granted start failed");
      this.publishStatus();
    });
  }

  /** Begins a hibernate in a job (spec §6.4). Resolves false when refused. Never waits for the exit. */
  hibernate(reason: HibernateReason): Promise<boolean> {
    return this.run(async () => {
      const ok = this.beginHibernate(reason);
      this.publishStatus();
      return ok;
    });
  }

  /**
   * The Supervisor's drop rules that only the runtime knows (spec §5.2): never archived or latched, and an errored
   * agent only for crash recovery, Restart, reset or a human's message.
   */
  acceptsWake(reason: WakeReason): boolean {
    if (this.archived || this.noStart) return false;
    return !this.errored || ERRORED_WAKES.has(reason);
  }

  /** A wake is only granted with something to write: a pending message or notice, or a queued compact (spec §5.2). */
  hasDeliverable(): boolean {
    return this.queue.length > 0;
  }

  /** A deliberate stop of the running process is under way: its slot is on its way back (spec §5.3). */
  isStopping(): boolean {
    return Boolean(this.proc) && this.stopping;
  }

  /** A job that changes nothing, so its end re-evaluates the warm timer (a credential pause changed, spec §6.3). */
  recheck(): void {
    void this.run(async () => this.publishStatus());
  }

  /** The fields that only the runtime knows. */
  live(): {
    status: AgentStatus;
    turnOpen: boolean;
    lastError?: string;
    restartPending: boolean;
    restartWaitingOn: number;
    waitingOn: WaitingOn;
  } {
    return {
      status: this.status(),
      turnOpen: Boolean(this.openTurnId),
      ...(this.lastError && this.errored ? { lastError: this.lastError } : {}),
      restartPending: this.restartPending,
      restartWaitingOn: this.restartPending ? this.nonAmbient() : 0,
      waitingOn: this.waitingOn(),
    };
  }

  /** What keeps the agent warm: live non-ambient tasks (oldest first) and the live cron count. */
  waitingOn(): WaitingOn {
    const tasks: WaitingOn["tasks"] = [];
    for (const [taskId, t] of this.liveTasks)
      if (!t.ambient)
        tasks.push({
          taskId,
          description: t.description,
          startedAt: new Date(t.startedAt).toISOString(),
        });
    return { tasks, crons: this.crons.size };
  }

  /** Spec §6.1: a stop now would lose work. */
  busy(): boolean {
    return (
      this.starting ||
      (Boolean(this.proc) && !this.started) ||
      Boolean(this.openTurnId) ||
      this.inFlight.length > 0 ||
      this.awaiting.length > 0 ||
      this.compactInFlight ||
      Boolean(this.hold) ||
      this.nonAmbient() > 0 ||
      this.owedNotifications > 0
    );
  }

  /** Spec §6.2: a live in-session cron keeps the process (and its slot) until it is gone. */
  pinned(): boolean {
    return this.crons.size > 0;
  }

  /**
   * Spec §6.3: running and started, not busy or pinned, no restart or stop under way, not errored, and nothing
   * deliverable queued unless the credential is paused (held deliveries wait for the reset wake).
   */
  hibernatable(): boolean {
    const proc = this.proc;
    return (
      Boolean(proc) &&
      this.started &&
      proc !== this.deadProc &&
      proc !== this.failingProc &&
      !this.stopping &&
      !this.noStart &&
      !this.busy() &&
      !this.pinned() &&
      !this.restartPending &&
      !this.errored &&
      (this.queue.length === 0 || this.credentialPaused())
    );
  }

  statusFrame(): AgentStatusFrame {
    const l = this.live();
    return { type: "agent_status", agent: this.agent.slug, ...l };
  }

  queueItems(): QueueItem[] {
    return this.queue.map((e) => this.itemOf(e));
  }

  /** Graceful stop (server shutdown, tests). Waits until the exit is persisted. */
  async stop(opts?: { graceMs?: number; termWaitMs?: number }) {
    // Synchronously, before any await: the exit this causes (or a restart's exit already on its way) never respawns.
    this.stopping = true;
    this.restartPending = false;
    // Takes over a hibernate or restart already under way (its exit must not wake); a failing start keeps its intent.
    if (this.proc && this.afterExit?.kind !== "failed_start" && this.afterExit?.kind !== "internal")
      this.afterExit = {
        kind: "hibernate",
        reason: this.archived ? "archived" : "shutdown",
        lost: this.lostSnapshot(),
      };
    this.publishStatus();
    this.stopsInProgress += 1;
    try {
      const p = this.proc;
      if (p) await p.stop(opts);
      await this.settled();
    } finally {
      this.stopsInProgress -= 1;
    }
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
    return this.jobs.run(async () => {
      try {
        return await job();
      } finally {
        this.updateWarmTimer(); // every input change re-evaluates the warm timer (spec §6.3)
      }
    });
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
        if (
          !(
            err instanceof AgentStartError ||
            err instanceof AgentArchivedError ||
            err instanceof NoOpenTurnError
          ) &&
          this.proc
        )
          await this.onJobFailure(this.proc, err);
        throw err;
      }
    });
  }

  // ---------- internals ----------

  private status(): AgentStatus {
    return statusOf({
      errored: this.errored,
      attempting: false, // the crash policy (Task 19) sets it
      working:
        this.starting ||
        (Boolean(this.proc) && !this.started) ||
        Boolean(this.openTurnId) ||
        this.awaiting.length > 0 ||
        this.compactInFlight,
      credentialPaused: this.credentialPaused(),
      hasPendingWork: this.queue.length > 0,
      queuedWake: this.slots.isQueued(this.agent.id),
      processRunning: Boolean(this.proc),
    });
  }

  private credentialPaused(): boolean {
    return this.d.credentialPaused?.() ?? false;
  }

  private itemOf(e: Entry): QueueItem {
    return e.kind === "message"
      ? {
          id: e.row.id,
          kind: e.row.kind === "system" ? "notice" : "message",
          body: e.row.body,
          urgent: e.row.urgent,
          from: fromOf(e),
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

  /** Publishes the status frame when it changed. The Supervisor calls it when the agent's queue entry changes. */
  publishStatus() {
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

  /** True while a process exists or a start is under way (prepare to spawn): host writes to the workdir must be staged. */
  hasProcess(): boolean {
    return Boolean(this.proc) || this.starting;
  }

  /**
   * Only called from API jobs (send, compact): asks for a slot and, when granted, starts inline so an immediate
   * start failure still rejects the call (S3's 503). A flush never restarts a dead process.
   */
  private async wakeInline(reason: WakeReason) {
    if (this.proc) return;
    if (this.slots.requestWake(this.agent.id, reason, true) === "granted")
      await this.startNow(reason);
  }

  /** From inside a job that isn't an API call: request a wake and start at once when the port grants it. */
  private async wakeFromJob(reason: WakeReason) {
    if (this.slots.requestWake(this.agent.id, reason, false) === "granted")
      await this.startAndFlush(reason, "wake failed");
  }

  /** `startNow` and a flush, with failures handled here (no API call to reject). */
  private async startAndFlush(reason: WakeReason, what: string) {
    try {
      await this.startNow(reason);
      await this.flush();
    } catch (err) {
      // A start failure is already recorded (an `error` event, errored with its real message and fix).
      if (!(err instanceof AgentStartError || err instanceof AgentArchivedError)) {
        if (this.proc) await this.onJobFailure(this.proc, err);
        else this.d.log.error({ err, agent: this.agent.slug }, what);
      }
    }
  }

  /**
   * Internal primitive, call only inside this agent's own job, with a slot granted: prepare, launch,
   * `process_started`. Any throw before the launch gives the slot back.
   */
  private async startNow(reason: WakeReason) {
    let launched = false;
    this.starting = true;
    try {
      await this.launch(reason, () => {
        launched = true;
      });
    } finally {
      this.starting = false;
      if (!launched) this.slots.release(this.agent.id);
    }
  }

  private async launch(reason: WakeReason, onLaunched: () => void) {
    if (this.archived) throw new AgentArchivedError(this.agent.slug);
    this.refuseWhileStopping();
    // prepareStart takes the agent's slug lock (KeyedMutex is not re-entrant). The runtime never holds that
    // lock: it has no handle to it, and its own serialization is the job queue.
    let spec: AgentRuntimeSpec;
    try {
      spec = await this.d.prepareStart(this.agent);
    } catch (err) {
      if (err instanceof AgentArchivedError) {
        this.archived = true;
        throw err;
      }
      const known = err instanceof AgentStartError;
      const message = known ? err.message : "The agent couldn't be prepared to start.";
      if (!known) this.d.log.error({ err, agent: this.agent.slug }, "prepareStart failed");
      await this.append(null, {
        type: "error",
        source: "spawn",
        message,
        ...(known && err.fix ? { fix: err.fix } : {}),
      });
      await this.setErrored(message);
      this.publishStatus();
      throw known ? err : new AgentStartError(message);
    }
    if (!this.firstStartDone) {
      this.firstStartDone = true;
      this.d.onFirstStart?.(spec);
    }
    const row = await this.d.store.agentById(this.agent.id);
    const resumeSessionId = row?.sessionId ?? undefined;
    // Right before the launch: a stop(), archive or the closing latch that arrived during prepare must not be outrun.
    this.refuseBeforeLaunch();
    const proc = this.d.driver.start(spec, resumeSessionId ? { resumeSessionId } : {});
    onLaunched();
    this.proc = proc;
    this.started = false;
    this.stopping = false; // only reached with no stop() in progress: this is a fresh start after it completed
    this.afterExit = undefined;
    this.liveTasks = new Map();
    this.crons = new Map();
    this.owedNotifications = 0;
    this.clearOwedBound();
    this.lastActivityAt = Date.now();
    // Pump first: its jobs queue behind this one, and if the append below fails the stop's `exited` is still consumed.
    void this.pump(proc);
    await this.append(null, {
      type: "process_started",
      resumed: Boolean(resumeSessionId),
      reason,
    });
    this.publishStatus();
  }

  /** Not recorded as a start failure: the agent isn't broken, it is being stopped (shutdown, archive). */
  private refuseWhileStopping() {
    if (this.stopsInProgress > 0 || this.noStart || this.slots.closing())
      throw new AgentStartError("The agent is being stopped.");
  }

  /** The last check before the launch: the stop latches, and an archive that landed during prepare. */
  private refuseBeforeLaunch() {
    if (this.archived) throw new AgentArchivedError(this.agent.slug);
    this.refuseWhileStopping();
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
    if (proc === this.proc) this.beginForceStop({ kind: "internal" });
    else void proc.stop({ graceMs: 0 }); // already gone from the runtime (its exit is being recorded)
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
        this.clearOwedBound(); // the bound only runs while no turn is open
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
        this.lastActivityAt = Date.now();
        if (e.command === "compact") this.compactInFlight = false;
        if (e.originKind === "task-notification")
          this.owedNotifications = Math.max(0, this.owedNotifications - 1);
        this.armOwedBound();
        if (e.originKind === "cron") await this.dropFiredOneShots();
        this.releaseHold();
        await this.flush();
        this.maybeRestart();
        break;
      }
      case "background_tasks": {
        const now = Date.now();
        this.liveTasks = new Map(
          e.tasks.map((t) => [
            t.taskId,
            {
              ambient: Boolean(t.ambient),
              description: t.description ?? "",
              startedAt: this.liveTasks.get(t.taskId)?.startedAt ?? now,
            },
          ]),
        );
        await this.append(this.openTurnId, e);
        await this.writeJournal();
        // Safe despite the empty set arriving before the notification turn: owedNotifications covers that turn.
        this.maybeRestart();
        break;
      }
      case "background_task_finished":
        this.owedNotifications += 1;
        this.armOwedBound();
        await this.append(this.openTurnId, e);
        break;
      case "cron_created":
        this.crons.set(e.cronId, {
          recurring: e.recurring,
          humanSchedule: e.humanSchedule,
          nextFireAt: e.nextFireAt,
          createdAt: Date.now(),
        });
        await this.append(this.openTurnId, e);
        await this.writeJournal();
        break;
      case "cron_deleted":
        this.crons.delete(e.cronId);
        await this.append(this.openTurnId, e);
        await this.writeJournal();
        break;
      case "error":
        await this.append(this.openTurnId, e);
        if (!this.started && (e.source === "resume" || e.source === "spawn")) {
          await this.setErrored(e.message);
          this.failingProc = proc;
          // A stop already under way (stop(), a shutdown) keeps its intent: its exit still does what it must.
          if (!this.afterExit) {
            this.stopping = true;
            this.afterExit = { kind: "failed_start" };
            void proc.stop({ graceMs: 1000 });
          }
        }
        break;
      case "exited":
        await this.onExited(proc, e);
        this.maybeRestart();
        break;
      default:
        await this.append(this.openTurnId, e);
    }
    this.publishStatus();
  }

  private async onExited(proc: HarnessProcess, e: Extract<HarnessEvent, { type: "exited" }>) {
    const intent = this.afterExit;
    this.afterExit = undefined;
    this.restartPending = false;
    this.liveTasks = new Map(); // tasks and crons die with the process
    this.crons = new Map();
    this.owedNotifications = 0;
    this.clearOwedBound();
    // Reset the in-memory state first, so the runtime can restart even if recording the exit fails (DB down).
    const rolledBack = this.inFlight.splice(0);
    const openTurnId = this.openTurnId;
    const usage = this.lastUsage;
    // Unconfirmed batches re-enter the head in their original order (spec §8.3 rule 7).
    this.queue.unshift(...rolledBack.flat());
    // Notices go ahead of rolled-back batches (spec §9.5); a stable partition keeps each group in order.
    this.queue = [...this.queue.filter(isNotice), ...this.queue.filter((e) => !isNotice(e))];
    this.openTurnId = undefined;
    this.releaseHold();
    this.compactInFlight = false;
    this.awaiting = [];
    if (this.proc === proc) this.proc = undefined;
    this.started = false;
    const crash = !intent && !e.expected ? this.onCrash(e) : false;
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
      if (intent?.kind === "hibernate") {
        await this.recordLostWork(intent, Boolean(openTurnId));
        await this.append(null, {
          type: "hibernated",
          reason: intent.reason,
          ...(intent.reason === "warm_window"
            ? { idleMinutes: Math.round((Date.now() - this.lastActivityAt) / 60_000) }
            : {}),
        });
      }
      if (crash) await this.d.store.setStatus(this.agent.id, "errored");
      // A crash keeps its journal: the lost work is reported from it.
      else await this.writeJournal();
    } finally {
      this.publishQueue();
      // Every exit gives the slot back once it is recorded (spec §5.2), even when recording failed.
      this.slots.release(this.agent.id);
    }
    // failed_start and internal never wake; a crash never wakes until the crash policy lands (Task 19).
    if (intent?.kind === "hibernate") {
      if (intent.reason !== "shutdown" && intent.reason !== "archived")
        await this.wakeAfterExit(
          intent.reason === "apply_changes" && intent.lost.crons.length
            ? "apply_changes"
            : "queued_items",
        );
    } else if (intent?.kind === "restart") await this.wakeAfterExit("restart");
  }

  /**
   * The lost-work part of a hibernate's `exited` job (spec §6.4): `background_work_lost`, then the notice the next
   * start delivers (factory-restarted for a shutdown that cut work short, restart-crons for an apply-restart).
   */
  private async recordLostWork(
    intent: Extract<AfterExit, { kind: "hibernate" }>,
    turnWasOpen: boolean,
  ) {
    const { reason, lost } = intent;
    const anyLost = lost.tasks.length > 0 || lost.crons.length > 0;
    if (anyLost && reason !== "warm_window" && reason !== "freed_slot") {
      await this.append(null, { type: "background_work_lost", reason, ...lost });
      this.d.log.info(
        { agent: this.agent.slug, manager: this.agent.reportsTo, reason, ...lost },
        "background work lost; would notify the manager",
      );
    }
    if (reason === "shutdown" && (turnWasOpen || anyLost))
      await this.addNotice(
        "factory_restarted",
        notices.factoryRestarted({ tasks: lost.tasks.map((t) => t.description || t.taskId) }),
      );
    else if (reason === "apply_changes" && lost.crons.length)
      await this.addNotice(
        "restart_crons",
        notices.restartCrons({ crons: lost.crons.map((c) => c.humanSchedule) }),
      );
  }

  /** S3's crash handling, kept until the crash policy (spec §9.2) replaces it. True when it marked errored. */
  private onCrash(e: Extract<HarnessEvent, { type: "exited" }>): boolean {
    if (this.errored) return false;
    this.errored = true;
    this.lastError =
      e.code !== null
        ? `Exited unexpectedly (code ${e.code})`
        : `Exited unexpectedly (${e.signal ?? "unknown"})`;
    return true;
  }

  /**
   * A wake at the end of an `exited` job, only with something to deliver. Re-checked here, not only when the stop
   * began: a stop(), archive or the closing latch may have landed while the exit was being recorded.
   */
  private async wakeAfterExit(reason: WakeReason) {
    if (!this.queue.length || this.proc) return;
    if (this.stopsInProgress > 0 || this.archived || this.noStart || this.slots.closing()) return;
    await this.wakeFromJob(reason);
  }

  /**
   * Stops the process for a pending restart once nothing would be lost (spec §6.5). Synchronous: it never awaits
   * the stop, because the `exited` that ends it is a job queued behind the caller.
   */
  private maybeRestart() {
    if (!this.restartPending || this.errored) return;
    this.beginHibernate("apply_changes");
  }

  /**
   * Internal primitive, call only inside this agent's own job (spec §6.4). Records the intent and starts the stop
   * without awaiting it; the `exited` job does the rest. False when refused.
   */
  private beginHibernate(reason: HibernateReason): boolean {
    const proc = this.proc;
    if (!proc || proc === this.deadProc || proc === this.failingProc) return false;
    const final = reason === "shutdown" || reason === "archived";
    if (this.stopping) {
      // A shutdown or archive takes over a hibernate already stopping: the same stop goes on, but its exit must
      // record the shutdown (notice, no wake). The snapshot stays the one taken when the stop began.
      if (!final || this.afterExit?.kind !== "hibernate") return false;
      this.afterExit.reason = reason;
      this.restartPending = false;
      return true;
    }
    if (reason === "warm_window" || reason === "freed_slot") {
      if (!this.hibernatable()) return false;
    } else if (reason === "apply_changes" && this.busy()) return false; // crons don't block it (spec §6.5)
    const intent: AfterExit = { kind: "hibernate", reason, lost: this.lostSnapshot() };
    this.stopping = true;
    this.afterExit = intent;
    void proc.stop({ graceMs: 3000, termWaitMs: 10_000 }).then(
      (r) => {
        if (!r.timedOut) return;
        void this.run(async () => {
          if (this.afterExit !== intent) return; // stop() took over
          this.afterExit = { kind: "internal" }; // a late exit must not wake (escalation lands in Task 19)
          this.restartPending = false;
          this.deadProc = proc;
          await this.setErrored(
            intent.reason === "apply_changes"
              ? "Couldn't restart the agent: the process didn't stop."
              : "Couldn't stop the agent: the process didn't stop.",
          );
          this.d.log.error(
            { agent: this.agent.slug, reason: intent.reason },
            "hibernate stop timed out",
          );
          this.publishStatus();
        });
      },
      (err) => this.d.log.error({ err, agent: this.agent.slug }, "hibernate stop failed"),
    );
    return true;
  }

  /** Internal primitive, call only inside this agent's own job: stop the current process now, never awaited. */
  private beginForceStop(intent: AfterExit): void {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    this.afterExit = intent;
    void proc
      .stop({ graceMs: 0 })
      .catch((err) => this.d.log.error({ err, agent: this.agent.slug }, "force stop failed"));
  }

  /** What a stop now would kill (spec §6.4 step 3). */
  private lostSnapshot(): LostWork {
    return {
      tasks: this.waitingOn().tasks.map(({ taskId, description }) => ({ taskId, description })),
      crons: [...this.crons].map(([cronId, c]) => ({ cronId, humanSchedule: c.humanSchedule })),
    };
  }

  private nonAmbient() {
    let n = 0;
    for (const t of this.liveTasks.values()) if (!t.ambient) n += 1;
    return n;
  }

  /**
   * Runs at the end of every job (spec §6.3): arms the warm timer when the agent is hibernatable, cancels it when
   * it isn't, and tells the Supervisor on the false→true edge. Also keeps the cron expiry timer. Never throws.
   */
  private updateWarmTimer() {
    const h = this.hibernatable();
    if (!h && this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = undefined;
    } else if (h && !this.warmTimer) {
      const minutes = this.agent.config.warmWindowMinutes ?? DEFAULT_WARM_WINDOW_MINUTES;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        void this.run(async () => {
          if (this.warmTimer !== timer) return; // cancelled, or a newer window began
          this.warmTimer = undefined;
          if (this.beginHibernate("warm_window")) this.publishStatus(); // re-checks hibernatable
        });
      }, minutes * 60_000);
      this.warmTimer = timer;
    }
    if (h && !this.wasHibernatable) this.slots.becameHibernatable(this.agent.id);
    this.wasHibernatable = h;
    this.updateCronExpiry();
  }

  /** One timer at the earliest cron expiry, so a pin can't outlive Claude's own 7-day expiry. */
  private updateCronExpiry() {
    const at =
      this.crons.size && !this.noStart
        ? Math.min(...[...this.crons.values()].map((c) => c.createdAt)) + CRON_EXPIRY_MS
        : undefined;
    if (at === this.cronExpiryAt) return;
    if (this.cronExpiryTimer) clearTimeout(this.cronExpiryTimer);
    this.cronExpiryTimer = undefined;
    this.cronExpiryAt = at;
    if (at === undefined) return;
    this.cronExpiryTimer = setTimeout(
      () => {
        void this.run(async () => {
          this.cronExpiryAt = undefined; // the end of this job arms the next expiry, if any
          const now = Date.now();
          const before = this.crons.size;
          for (const [id, c] of this.crons)
            if (now - c.createdAt >= CRON_EXPIRY_MS) this.crons.delete(id);
          if (this.crons.size !== before) {
            await this.writeJournal();
            this.publishStatus();
          }
        });
      },
      Math.max(0, at - Date.now()),
    );
  }

  /** One-shots auto-delete with no `CronDelete` (S0): gone once their time passed and a cron turn ended after it. */
  private async dropFiredOneShots() {
    const now = Date.now();
    const before = this.crons.size;
    for (const [id, c] of this.crons)
      if (!c.recurring && c.nextFireAt <= now) this.crons.delete(id);
    if (this.crons.size !== before) await this.writeJournal();
  }

  /** Spec §6.1: armed only while no turn is open and a notification turn is owed. */
  private armOwedBound() {
    this.clearOwedBound();
    if (this.owedNotifications <= 0 || this.openTurnId || this.noStart) return;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void this.run(async () => {
        if (this.owedTimer !== timer) return;
        this.owedTimer = undefined;
        if (this.owedNotifications <= 0 || this.openTurnId) return;
        this.d.log.warn(
          { agent: this.agent.slug, owed: this.owedNotifications },
          "no notification turn within 30 s; no longer waiting for it",
        );
        this.owedNotifications = 0;
        this.maybeRestart();
        this.publishStatus();
      });
    }, OWED_BOUND_MS);
    this.owedTimer = timer;
  }

  private clearOwedBound() {
    if (this.owedTimer) clearTimeout(this.owedTimer);
    this.owedTimer = undefined;
  }

  /** Writes runtime_journal's tasks and crons (spec §12) when they changed; cleared once both are empty. */
  private async writeJournal() {
    const { tasks, crons } = this.lostSnapshot();
    const j: RuntimeJournal | null =
      tasks.length || crons.length ? { tasks, crons, takenAt: new Date().toISOString() } : null;
    const json = j ? JSON.stringify({ tasks, crons }) : "null";
    if (json === this.journalJson) return;
    await this.d.store.setRuntimeJournal(this.agent.id, j);
    this.journalJson = json;
  }

  private async urgentInterrupt(by: string) {
    // idle → normal send; hold active → no second interrupt; a compact in flight is never interrupted (it
    // waits behind the barrier instead)
    if (!this.proc || !this.openTurnId || this.hold || this.compactInFlight) return;
    try {
      await this.proc.control("interrupt");
    } catch (err) {
      // The process is going away: skip the interrupt and the hold. The message stays queued and the coming
      // `exited` cleans up; this is not an internal error.
      if (err instanceof ProcessNotRunningError) return;
      throw err;
    }
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
          this.maybeRestart();
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

  /** Strict FIFO from the head while allowed (spec §8.3). Never starts a process. Holds everything during a stop. */
  private async flush() {
    while (
      this.proc &&
      !this.stopping &&
      !this.hold &&
      !this.compactInFlight &&
      this.queue.length
    ) {
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
    this.lastActivityAt = Date.now();
    if (!this.started) this.inFlight.push(batch);
    if (!turnAtWrite) this.awaiting.push(ids);
    this.publishQueue();
    return true;
  }
}
