import { randomUUID } from "node:crypto";
import type { AgentRow, MessageRow, RuntimeJournal } from "@open-factory/db";
import {
  type AgentRuntimeSpec,
  type ExitInfo,
  type FactoryMessage,
  type HarnessDriver,
  type HarnessProcess,
  ProcessNotRunningError,
} from "@open-factory/harness";
import {
  type AgentStatus,
  type AgentStatusFrame,
  type AnyEvent,
  type ErrorKind,
  errorKindSchema,
  type HarnessEvent,
  type QueueItem,
  statusOf,
  type WaitingOn,
} from "@open-factory/shared";
import { LOCAL_RUNTIME_DISABLED } from "../config.ts";
import {
  type ContainerManager,
  type EnsureResult,
  ImageMissingError,
} from "../runtime/docker/containers.ts";
import { dockerStartError } from "../runtime/docker/errors.ts";
import type { SlotPort, WakeReason } from "../supervisor/slots.ts";
import { WorkspaceError } from "../workspace/links.ts";
import {
  AgentArchivedError,
  AgentStartError,
  NoOpenTurnError,
  RecoveryRefusedError,
} from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, Tx } from "./event-store.ts";
import { type NoticeType, notices } from "./notices.ts";
import { classifyResumeFailure } from "./resume-failure.ts";
import { SerialQueue } from "./serial-queue.ts";
import type { PreparedSpec, PrepareStart } from "./start.ts";

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
  /** The Supervisor's slot port (spec §5.2), which also owns the credential pauses (§7). */
  slots: SlotPort;
  /**
   * Cleans up what a crashed process left (spec §9.2 step 1): local, the journal reap (§12); Docker, the
   * container stop (§11.3). Resolves what it did (recorded as a `cleanup` event); a throw means a container stop
   * failed, which makes the agent `stop_failed` (§9.6). Defaults to a no-op.
   */
  cleanup?: (agent: AgentRow) => Promise<CleanupResult | undefined>;
  /**
   * Local agents only (spec §12): snapshots Claude's process tree (pids with start times) into `runtime_journal`, so
   * the cleanup can reap what a dead process left. Absent with a fake driver: a fake pid is not ours to journal.
   */
  journal?: { snapshot(claudePid: number): Promise<ProcessPart> };
  /** The local gate (`localRuntimeAllowed(config)`), read live because it can change; defaults to allowed. */
  localRuntimeAllowed?: () => boolean;
  /** The Docker launcher (spec §10 step 4, §11): the one ContainerManager and the in-container Claude path. */
  docker?: DockerDeps;
}

export interface DockerDeps {
  containers: Pick<ContainerManager, "ensure" | "stopIfRunning" | "forceRemove">;
  /** `FACTORY_DOCKER_CLAUDE_BIN`. */
  claudeBin: string;
  /** `ensure` found the image gone after the pull check: the next wake checks and pulls again. */
  onImageMissing?: (image: string) => void;
}

/** The local part of `runtime_journal` (spec §12). */
export type ProcessPart = Required<Pick<RuntimeJournal, "claude" | "descendants">>;

/**
 * Within one process lifetime the journaled descendants are a union (spec §12): a process reparented away from Claude
 * (`nohup x &` from a shell that then exited) drops out of the next `ps` walk but must still be reaped. Keyed by pid:
 * a new start time for the same pid replaces the old entry. Every signal is still start-time verified.
 */
export function mergeSnapshot(prev: ProcessPart | undefined, snap: ProcessPart): ProcessPart {
  if (!prev || prev.claude.pid !== snap.claude.pid || prev.claude.start !== snap.claude.start)
    return snap;
  const byPid = new Map(prev.descendants.map((d) => [d.pid, d]));
  for (const d of snap.descendants) byPid.set(d.pid, d);
  return { claude: snap.claude, descendants: [...byPid.values()] };
}

/** The process part with the carried pids added to its descendants (the process's own entry wins on a shared pid). */
function withCarried(
  proc: ProcessPart | undefined,
  carried: ProcessPart["descendants"],
): Partial<ProcessPart> | undefined {
  if (!carried.length) return proc;
  if (!proc) return { descendants: carried };
  const own = new Set(proc.descendants.map((d) => d.pid));
  return {
    claude: proc.claude,
    descendants: [...proc.descendants, ...carried.filter((d) => !own.has(d.pid))],
  };
}

export type CleanupResult = { killedProcesses?: number; container?: "stopped" | "removed" };

/** What a crashed process left (spec §9.2 step 3): an open turn, a written batch not yet answered, live tasks/crons. */
type CrashLive = { turnOpen: boolean; batchUnanswered: boolean; lost: LostWork };

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
  // Restart and Start a new session: the exit releases the slot and makes the attempt's wake, if one is on.
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

/** How long an escalated stop (SIGKILL, container stop) may take to produce the exit (spec §9.6). */
const ESCALATION_EXIT_MS = 5_000;
/** Spec §9.6's text; the pid, when known, is in the detail (the status line is just "Errored"). */
const stopFailedMessage = (pid: number | undefined) =>
  `The agent's process can't be stopped. Check the host${pid ? ` (pid ${pid})` : ""} or Docker, then restart again.`;
/** A local start found the previous process's journal and couldn't reap it (spec §9.6, §12). */
const previousProcessMessage = (pid: number | undefined) =>
  `The agent's previous process couldn't be stopped. Check the host${pid ? ` (pid ${pid})` : ""}, then restart again.`;

/** The owed-notification bound (spec §6.1). */
const OWED_BOUND_MS = 30_000;
/** Local process-tree snapshots while a turn is open or a task is live (spec §12). */
const JOURNAL_SNAPSHOT_MS = 10_000;
/** The pause when a `rejected` rate limit reports no usable reset time (spec §7.2). */
const RATE_LIMIT_FALLBACK_MS = 30 * 60_000;
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
  private errorKind: ErrorKind | undefined;
  // Spec §9.2: an attempt to bring back interrupted work is in progress (persisted). `attemptReason` is its wake's
  // reason (the only wake accepted meanwhile); the attempt succeeds at the first origin-less turn_end after a batch.
  private attempting: boolean;
  private attemptReason: WakeReason | undefined;
  private attemptBatchWritten = false;
  // A human's message reached an errored agent whose failing process hadn't exited yet: attempt at that exit.
  private attemptOwedAtExit = false;
  private readonly escalations = new WeakMap<HarnessProcess, Promise<void>>();
  private readonly escalated = new WeakSet<HarnessProcess>(); // SIGKILLed or container-stopped: its exit reaps (§9.6)
  private escalationTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStatusJson = "";
  private firstStartDone = false;
  private submitted = 0;
  // Apply-restart (spec §13)
  private restartPending = false;
  private stopping = false; // a deliberate stop of the current process began: flush() writes nothing
  private stopsInProgress = 0; // stop() calls not yet returned: no process may be spawned meanwhile
  private afterExit: AfterExit | undefined; // the intent of the stop in progress, consumed by the `exited` job
  private noStart = false; // the closing latch (spec §5.6): never launch again
  // The runtime of the last launched process (or of a container a start left that couldn't be stopped): its exit and
  // cleanup follow it, even if a re-sync changed the row since.
  private procRuntime: "local" | "docker" | undefined;
  private lastImage: string | undefined; // Docker: the image reference of the last start (spec §8.2)
  // A start whose container couldn't be stopped (spec §9.6): stop_failed, and startNow must not give the slot back.
  private keepSlotAfterFailedStart = false;
  // `ensure` found the image gone once since the last launch: the wake went back through the pull (spec §11.2).
  private imageRequeued = false;
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
  // runtime_journal (spec §12): the tasks/crons part and the local process part, merged into one write.
  private journalWork: LostWork = { tasks: [], crons: [] };
  private journalProc: ProcessPart | undefined;
  // Pids a pre-start reap signalled (spec §12): kept in the journal until a later reap, in case one survived.
  private carriedPids: ProcessPart["descendants"] = [];
  private journalJson = "null"; // what was last written, without takenAt
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitedTurn = false; // a `rate_limited` event since the last turn end (spec §7.3)
  /** The last turn end, delivery or start (spec §5.3: the least recently active is evicted first). */
  lastActivityAt = Date.now();

  constructor(private readonly d: RuntimeDeps) {
    this.agent = d.agent;
    this.errored = d.agent.status === "errored";
    this.lastError = d.agent.lastError ?? undefined;
    const kind = errorKindSchema.safeParse(d.agent.errorKind);
    this.errorKind = kind.success ? kind.data : undefined;
    this.attempting = d.agent.attempting;
    this.archived = Boolean(d.agent.archivedAt);
    this.slots = d.slots;
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
      // A human's message to an errored agent is one attempt (spec §9.2); notices never wake one.
      if (this.messageStartsAttempt()) await this.beginAttempt("message", true);
      else {
        if (this.messageMayAttempt() && this.proc) this.attemptOwedAtExit = true;
        await this.wakeInline("message");
      }
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

  /**
   * Refreshes the row (renames, template-driven edits, a credential change) and the archived flag. The caller
   * (`AgentRuntimes.refresh`) re-pumps the Supervisor's queue afterwards, so a credential change takes effect.
   */
  async reload(): Promise<void> {
    await this.run(async () => {
      const r = await this.d.store.agentById(this.agent.id);
      if (r) {
        const moved = r.credentialId !== this.agent.credentialId;
        this.agent = r;
        this.archived = Boolean(r.archivedAt);
        if (moved) await this.onCredentialChanged();
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

  /**
   * Restart (spec §9.7): the restart notice, `control{restart}`, then one attempt. A process left is force-stopped
   * and its exit makes the wake; a `stop_failed` agent gets one more escalation try first (§9.6).
   */
  restart(r: { byHandle: string; runtimeAllowed: boolean }): Promise<void> {
    return this.apiJob(async () => {
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      this.refuseRecoveryWhileAttempting();
      if (!this.errored)
        throw new RecoveryRefusedError(
          "not_errored",
          `@${this.agent.slug} isn't errored. Restart is only for an errored agent.`,
        );
      if (this.errorKind === "resume_unrecoverable")
        throw new RecoveryRefusedError(
          "resume_unrecoverable",
          "This session can't be resumed. Start a new session instead.",
        );
      if (!r.runtimeAllowed)
        throw new RecoveryRefusedError("runtime_disabled", LOCAL_RUNTIME_DISABLED);
      this.refuseWhileStopping();
      const by = `@${r.byHandle}`;
      const lost = this.proc ? this.lostSnapshot() : { tasks: [], crons: [] };
      await this.addNotice(
        "restart",
        notices.restart({
          by,
          tasks: lost.tasks.map((t) => t.description || t.taskId),
          crons: lost.crons.map((c) => c.humanSchedule),
        }),
      );
      await this.append(null, { type: "control", cmd: "restart", by });
      if (this.stopFailed()) await this.retryStopFailed(by);
      else if (this.proc) {
        await this.markAttempting("restart");
        this.beginForceStop({ kind: "restart", by }, { graceMs: 0, termWaitMs: 3000 });
      } else await this.beginAttempt("restart", false);
      this.publishStatus();
    });
  }

  /**
   * Start a new session (spec §9.7), only after a failed resume: clear the session id, `session_reset`, drop the
   * pending notices (they describe the old session), clear errored, and make pending human messages the new
   * session's first turn (one attempt). The old session's JSONL stays on disk.
   */
  resetSession(r: { byHandle: string }): Promise<void> {
    return this.apiJob(async () => {
      if (this.archived) throw new AgentArchivedError(this.agent.slug);
      this.refuseRecoveryWhileAttempting();
      if (
        !this.errored ||
        (this.errorKind !== "resume" && this.errorKind !== "resume_unrecoverable")
      )
        throw new RecoveryRefusedError(
          "reset_not_allowed",
          "Start a new session is only for an agent whose session couldn't be resumed.",
        );
      this.refuseWhileStopping();
      const by = `@${r.byHandle}`;
      await this.d.store.setSessionId(this.agent.id, null);
      await this.append(null, { type: "session_reset", by });
      await this.d.store.deletePendingNotices(this.agent.id);
      // Written to a failing start but never confirmed: still pending rows, so they are gone too.
      this.queue = this.queue.filter((e) => !isNotice(e));
      this.inFlight = this.inFlight
        .map((b) => b.filter((e) => !isNotice(e)))
        .filter((b) => b.length > 0);
      this.publishQueue();
      this.errored = false;
      this.lastError = undefined;
      this.errorKind = undefined;
      await this.d.store.clearErrored(this.agent.id);
      const humans = this.queue.some((e) => e.kind === "message") || this.inFlight.length > 0;
      if (this.proc) {
        // The failed start's process is still exiting: its exit makes the wake.
        if (humans) await this.markAttempting("reset");
        this.beginForceStop({ kind: "restart", by }, { graceMs: 0, termWaitMs: 3000 });
      } else if (humans) await this.beginAttempt("reset", false);
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

  /**
   * The closing latch dropped this agent's queued wake (spec §5.6). An attempt waiting on it never started a process,
   * so it ends here (memory and DB) rather than read as cut short at the next boot (§5.7 step 4). Its durable cause
   * stays: a `boot_resume` keeps its pending factory-restarted notice, a crash recovery its errored state.
   */
  wakeDropped(): Promise<void> {
    return this.run(async () => {
      if (this.attemptReason) await this.endAttemptIfNothingStarts(this.attemptReason);
      this.publishStatus();
    });
  }

  /** The Supervisor's grant job: start with the slot it handed over, or give it back when no longer eligible. */
  grant(granted: WakeReason): Promise<void> {
    return this.run(async () => {
      const reason = this.wakeReason(granted);
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
        await this.endAttemptIfNothingStarts(reason);
        this.publishStatus();
        return;
      }
      await this.startAndFlush(reason, "granted start failed");
      await this.endAttemptIfNothingStarts(reason);
      this.publishStatus();
    });
  }

  /**
   * Boot's wake (spec §5.7 steps 5–6), never inline: `boot`, or `boot_resume` for interrupted work (a factory-restarted
   * notice is pending), which is its single automatic attempt, persisted as it is woken (§9.2).
   */
  bootWake(reason: "boot" | "boot_resume"): Promise<void> {
    return this.run(async () => {
      if (reason === "boot_resume") await this.beginAttempt(reason, false);
      else await this.wakeFromJob(reason);
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
   * The Supervisor's drop rules that only the runtime knows (spec §5.2, §9.2, §9.3, §9.6): never archived or
   * latched; while attempting, only the attempt's own wake; `stop_failed` only for Restart; `resume_unrecoverable`
   * only for Start a new session; any other errored agent only for crash recovery, Restart, reset or a human's message.
   */
  acceptsWake(reason: WakeReason): boolean {
    if (this.archived || this.noStart) return false;
    if (this.attempting) return reason === this.attemptReason;
    if (!this.errored) return true;
    if (this.errorKind === "stop_failed") return reason === "restart";
    if (this.errorKind === "resume_unrecoverable") return reason === "reset";
    return ERRORED_WAKES.has(reason);
  }

  /**
   * The reason a queued or granted wake starts this agent with. While attempting it is the attempt's own: a queue
   * entry or grant from an older request (the Supervisor keeps one per agent, with its first reason) becomes the
   * attempt's start, so Restart or Start a new session is never dropped for an entry it found.
   */
  wakeReason(requested: WakeReason): WakeReason {
    return this.attempting && this.attemptReason ? this.attemptReason : requested;
  }

  /** A wake is only granted with something to write: a pending message or notice, or a queued compact (spec §5.2). */
  hasDeliverable(): boolean {
    return this.queue.length > 0;
  }

  /** A deliberate stop of the running process is under way: its slot is on its way back (spec §5.3). */
  isStopping(): boolean {
    return Boolean(this.proc) && this.stopping && !this.stopFailed();
  }

  /** The stop failed even after escalation (spec §9.6): the process may still run and keeps the slot. */
  private stopFailed(): boolean {
    return this.errored && this.errorKind === "stop_failed";
  }

  /** A job that changes nothing, so its end re-evaluates the warm timer (a credential pause changed, spec §6.3). */
  recheck(): void {
    void this.run(async () => this.publishStatus());
  }

  /**
   * The reset of an owed agent (spec §7.3), while its credential is still paused: `rate_limit_reset`, then the
   * continue notice at the head of the queue, then the flag clears. Starts nothing (the Supervisor wakes after).
   */
  rateLimitReset(
    n: { credential: string; at?: Date },
    /** Re-checked inside the job: false when a later window replaced the one being reset (the flag stays). */
    current: () => boolean = () => true,
  ): Promise<void> {
    return this.run(async () => {
      if (!current()) return;
      await this.append(null, { type: "rate_limit_reset", credential: n.credential });
      await this.addNotice("rate_limit_reset", notices.rateLimitReset(n));
      await this.d.store.setNoticeOwed(this.agent.id, false);
      this.agent = { ...this.agent, rateLimitNoticeOwed: false };
      this.publishStatus();
    });
  }

  /** The credential's pause ended (spec §7.2): a running agent flushes what was held, a hibernated one asks for a wake. */
  resumeAfterReset(): void {
    void this.run(async () => {
      if (this.proc) await this.flushOrStop("flush after the reset failed");
      else if (this.queue.length) await this.wakeFromJob("rate_limit_reset");
      this.publishStatus();
    });
  }

  /**
   * The Supervisor's pull of this agent's image failed (spec §11.2): its wake was dropped, so the start fails here,
   * with the registry's error verbatim. An attempt waiting on that wake ends with it.
   */
  imagePullFailed(message: string): Promise<void> {
    return this.run(async () => {
      if (this.proc || this.starting) return; // started meanwhile through another wake: nothing failed
      await this.append(null, { type: "error", source: "spawn", message });
      await this.setErrored(message, "start");
      this.publishStatus();
    });
  }

  /** The fields that only the runtime knows. */
  live(): {
    status: AgentStatus;
    turnOpen: boolean;
    lastError?: string;
    errorKind?: ErrorKind;
    restartPending: boolean;
    restartWaitingOn: number;
    waitingOn: WaitingOn;
    rateLimitedUntil?: string;
    rateLimitExact?: boolean;
    runtimeDisabled?: string;
    image?: string;
    pulling?: boolean;
  } {
    const pause = this.slots.pauseOf(this.agent.id);
    return {
      status: this.status(),
      turnOpen: Boolean(this.openTurnId),
      ...(pause
        ? { rateLimitedUntil: pause.until.toISOString(), rateLimitExact: pause.exact }
        : {}),
      ...(this.lastError && this.errored ? { lastError: this.lastError } : {}),
      ...(this.errorKind && this.errored ? { errorKind: this.errorKind } : {}),
      ...(this.agent.runtime === "local" && !(this.d.localRuntimeAllowed?.() ?? true)
        ? { runtimeDisabled: LOCAL_RUNTIME_DISABLED }
        : {}),
      ...(this.lastImage ? { image: this.lastImage } : {}),
      ...(this.slots.isPulling(this.agent.id) ? { pulling: true } : {}),
      restartPending: this.restartPending,
      restartWaitingOn: this.restartPending ? this.nonAmbient() : 0,
      waitingOn: this.waitingOn(),
    };
  }

  /** What keeps the agent warm: live non-ambient tasks (oldest first) and the live cron count. */
  waitingOn(): WaitingOn {
    const live = [...this.liveTasks].filter(([, t]) => !t.ambient);
    live.sort(([, a], [, b]) => a.startedAt - b.startedAt); // stable: same-ms tasks keep the event's order
    const tasks: WaitingOn["tasks"] = live.map(([taskId, t]) => ({
      taskId,
      description: t.description,
      startedAt: new Date(t.startedAt).toISOString(),
    }));
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
      !this.attempting &&
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

  /**
   * Shutdown and archive (spec §5.6, §6.6): the one hibernate path, `beginHibernate("shutdown")` (or `"archived"`
   * after `markArchived`) in a job, taking over a hibernate already stopping; then waits until the exit is recorded,
   * escalating a stop that times out (§9.6). Call it from outside this agent's jobs (the shutdown hook, the archive
   * route). `opts` is the stop's timing when this call begins it (default 3 s grace, 10 s after SIGTERM).
   *
   * Not bounded on its own: the stop begins only once the job at the head of the agent's queue finishes (a hung DB
   * call, a Docker `exited` job's container stop, bounded at 15 s). At shutdown the 20 s force-exit is the backstop,
   * and the next boot reaps whatever was left (the journal of an unclean exit isn't cleared; Docker containers are
   * stopped, spec §5.7).
   */
  async stop(opts?: { graceMs?: number; termWaitMs?: number }) {
    // Synchronously, before any await: nothing launches from here on (refuseWhileStopping), even a start already
    // inside prepareStart, and an apply-restart waiting for its moment is dropped.
    this.stopsInProgress += 1;
    this.restartPending = false;
    this.publishStatus();
    try {
      const proc = await this.run(async () => {
        this.restartPending = false;
        this.beginHibernate(this.archived ? "archived" : "shutdown", opts);
        this.publishStatus();
        // The stop under way is the one to wait for: this one, or a Restart's or a failed start's (each with its own
        // intent, none of which wakes now). A stop_failed process gets one more escalation try (§9.6).
        return this.proc;
      });
      // stop() is idempotent per process: this joins the stop already under way.
      if (proc && (await proc.stop()).timedOut) await this.escalate(proc); // spec §9.6
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
        this.updateSnapshotTimer();
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
            err instanceof NoOpenTurnError ||
            err instanceof RecoveryRefusedError
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
      attempting: this.attempting,
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
    return this.slots.pauseOf(this.agent.id) !== undefined;
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

  /**
   * Errored with its reason (spec §8.3), in memory first so a failing DB write keeps the truth. Any error ends an
   * attempt in progress: this is the attempt's failure (spec §9.2).
   */
  private async setErrored(message: string, kind: ErrorKind) {
    this.errored = true;
    this.lastError = message;
    this.errorKind = kind;
    this.attempting = false;
    this.attemptReason = undefined;
    await this.d.store.setErrored(this.agent.id, message, kind);
  }

  /** Spec §9.2: a human's message to an errored agent makes one attempt, unless recovery needs another action. */
  private messageStartsAttempt(): boolean {
    return !this.proc && this.messageMayAttempt();
  }

  private messageMayAttempt(): boolean {
    return (
      this.errored &&
      !this.attempting &&
      this.errorKind !== "resume_unrecoverable" &&
      this.errorKind !== "stop_failed"
    );
  }

  /**
   * Spec §9.2: begin an attempt (persisted, so boot can tell one cut short) and request its wake. `inline` for an API
   * job (an immediate start failure rejects the call). A dropped wake ends the attempt at once: nothing will start.
   */
  private async beginAttempt(reason: WakeReason, inline: boolean) {
    await this.markAttempting(reason);
    try {
      if (inline) await this.wakeInline(reason);
      else await this.wakeFromJob(reason);
    } finally {
      await this.endAttemptIfNothingStarts(reason);
    }
  }

  /** The attempt's flag (memory and DB) without its wake: a stop's exit requests it (Restart of a process left). */
  private async markAttempting(reason: WakeReason) {
    this.attempting = true;
    this.attemptReason = reason;
    this.attemptBatchWritten = false;
    this.attemptOwedAtExit = false;
    await this.d.store.setAttempting(this.agent.id, true);
    this.publishStatus();
  }

  /** Spec §9.2: no Restart or Start a new session in the middle of an attempt. */
  private refuseRecoveryWhileAttempting() {
    if (this.attempting)
      throw new RecoveryRefusedError(
        "attempt_in_progress",
        `@${this.agent.slug} is already being recovered. Wait for that attempt to finish.`,
      );
  }

  /**
   * Restart of a `stop_failed` agent (spec §9.6): one more escalation try. With the process left: SIGKILL or the
   * container stop again, and the exit (intent restart) releases the slot and wakes; a failure is `stop_failed`
   * again (intent internal, no wake). With no process (a crash's cleanup failed): the cleanup again, then the held
   * slot is released and the restart's wake follows as usual.
   */
  private async retryStopFailed(by: string) {
    await this.markAttempting("restart");
    const proc = this.proc;
    if (proc) {
      this.stopping = true;
      this.afterExit = { kind: "restart", by };
      await this.escalateNow(proc, { removeOnFailure: true });
      return;
    }
    let done: CleanupResult | undefined;
    try {
      done = await this.d.cleanup?.(this.cleanupTarget());
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.slug }, "cleanup on restart failed");
      // Docker's last resort (spec §9.6): the container stop failed again, so remove the container.
      done = (await this.removeContainer()) ? { container: "removed" } : undefined;
      if (!done) {
        await this.setErrored(stopFailedMessage(undefined), "stop_failed");
        this.slots.stopFailed(this.agent.id);
        return;
      }
    }
    this.journalProc = undefined;
    this.carriedPids = [];
    await this.persistJournal();
    if (done) await this.append(null, { type: "cleanup", ...done });
    this.slots.release(this.agent.id);
    await this.wakeFromJob("restart");
    await this.endAttemptIfNothingStarts("restart");
  }

  /**
   * Every refusal of an attempt's start clears it (memory and DB): a dropped wake, a start refused without an error
   * (a stop in progress, the closing latch, archived) or a grant found ineligible. Not while a process exists, a start
   * is under way, or the wake still waits for a slot (queued, granted, or requeued for a pause).
   */
  private async endAttemptIfNothingStarts(reason: WakeReason) {
    if (!this.attempting || this.attemptReason !== reason) return;
    if (this.proc || this.starting || this.slots.isQueued(this.agent.id)) return;
    this.attempting = false;
    this.attemptReason = undefined;
    await this.d.store.setAttempting(this.agent.id, false);
    this.publishStatus();
  }

  /** Spec §9.2: the attempt's batch turn ended with the process running. Clears the attempt and the error. */
  private async attemptSucceeded() {
    this.attempting = false;
    this.attemptReason = undefined;
    this.errored = false;
    this.lastError = undefined;
    this.errorKind = undefined;
    await this.d.store.clearErrored(this.agent.id);
  }

  /** The runtime's own drop rules first (any slot port), then the slot port's. */
  private requestWake(reason: WakeReason, inline: boolean): "granted" | "queued" | "dropped" {
    if (!this.acceptsWake(reason)) return "dropped";
    return this.slots.requestWake(this.agent.id, reason, inline);
  }

  /** True while a process exists or a start is under way (prepare to spawn): host writes to the workdir must be staged. */
  hasProcess(): boolean {
    return Boolean(this.proc) || this.starting;
  }

  /**
   * Only called from API jobs (send, compact): asks for a slot and, when granted, starts inline so an immediate
   * start failure still rejects the call (S3's 503). A flush never restarts a dead process.
   */
  private async wakeInline(reason: WakeReason): Promise<boolean> {
    if (this.proc) return true;
    const r = this.requestWake(reason, true);
    if (r === "granted") await this.startNow(reason);
    return r !== "dropped";
  }

  /**
   * From inside a job that isn't an API call: request a wake and start at once when the port grants it. False when
   * the wake was dropped.
   */
  private async wakeFromJob(reason: WakeReason): Promise<boolean> {
    const r = this.requestWake(reason, false);
    if (r === "granted") await this.startAndFlush(reason, "wake failed");
    return r !== "dropped";
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
    let requeue = false;
    this.starting = true;
    this.keepSlotAfterFailedStart = false;
    try {
      requeue = !(await this.launch(reason, () => {
        launched = true;
      }));
    } catch (err) {
      this.imageRequeued = false; // this wake ended: the next one may re-pull a vanished image once again
      throw err;
    } finally {
      this.starting = false;
      // A container that couldn't be stopped keeps the slot (stop_failed, spec §9.6).
      if (!launched && !this.keepSlotAfterFailedStart) this.slots.release(this.agent.id);
    }
    // A pause that landed after the grant (spec §5.2), or an image that went missing (spec §11.2, through the pull):
    // back to the queue (a granted entry keeps its place).
    if (requeue && !this.keepSlotAfterFailedStart) {
      this.requestWake(reason, false);
      this.publishStatus();
    }
  }

  /**
   * False when nothing launched and the wake goes back to the queue: the credential was paused meanwhile (no first line
   * could be written), or the image went missing (the wake is pulled again).
   */
  private async launch(reason: WakeReason, onLaunched: () => void): Promise<boolean> {
    if (this.archived) throw new AgentArchivedError(this.agent.slug);
    this.refuseWhileStopping();
    // prepareStart takes the agent's slug lock (KeyedMutex is not re-entrant). The runtime never holds that
    // lock: it has no handle to it, and its own serialization is the job queue.
    let prepared: PreparedSpec;
    try {
      prepared = await this.d.prepareStart(this.agent);
    } catch (err) {
      if (err instanceof AgentArchivedError) {
        this.archived = true;
        throw err;
      }
      return this.failStart(err, "prepareStart failed");
    }
    const { launch: dockerLaunch, ...prepSpec } = prepared;
    let spec: AgentRuntimeSpec = prepSpec;
    if (!this.firstStartDone) {
      this.firstStartDone = true;
      this.d.onFirstStart?.(spec);
    }
    // Docker (spec §10 step 4): the container, outside the workspace lock; any throw from here to the launch stops it.
    let container: (EnsureResult & { image: string }) | undefined;
    if (spec.runtime === "docker") {
      container = await this.ensureContainer(spec, dockerLaunch);
      if (!container) return false;
      spec = {
        ...spec,
        docker: { containerId: container.containerId, claudeBin: this.dockerDeps().claudeBin },
      };
    }
    let resumeSessionId: string | undefined;
    try {
      const row = await this.d.store.agentById(this.agent.id);
      resumeSessionId = row?.sessionId ?? undefined;
      if (spec.runtime === "local") await this.reapBeforeLocalStart(row?.runtimeJournal ?? null);
      // Right before the launch: a stop(), archive or the closing latch that arrived during prepare must not be outrun.
      this.refuseBeforeLaunch();
    } catch (err) {
      if (container) await this.stopUnlaunchedContainer();
      throw err;
    }
    if (this.credentialPaused()) {
      if (container) await this.stopUnlaunchedContainer();
      return false;
    }
    const proc = this.d.driver.start(spec, resumeSessionId ? { resumeSessionId } : {});
    onLaunched();
    this.proc = proc;
    this.procRuntime = spec.runtime;
    this.imageRequeued = false;
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
    if (container) {
      this.lastImage = container.image;
      await this.append(null, {
        type: "container",
        action: container.action,
        image: container.image,
        imageId: container.imageId,
        ...(container.claudeCodeVersion ? { claudeCodeVersion: container.claudeCodeVersion } : {}),
      });
    }
    await this.append(null, {
      type: "process_started",
      resumed: Boolean(resumeSessionId),
      reason,
    });
    this.journalProc = undefined; // a new process: its own journaled tree starts empty
    await this.snapshotJournal(proc);
    this.publishStatus();
    return true;
  }

  /**
   * Never two processes for one session (spec §12, §5.7): a local start first reaps whatever `runtime_journal` still
   * names (a boot reap that failed keeps it). When that reap fails, the start fails `stop_failed` and keeps the slot
   * (§9.6). Pids it signalled are carried into the new process's journal, so a later reap still covers them.
   */
  private async reapBeforeLocalStart(j: RuntimeJournal | null) {
    const pids = [...(j?.claude ? [j.claude] : []), ...(j?.descendants ?? [])];
    this.carriedPids = [];
    if (!pids.length || !this.d.cleanup) return;
    let done: CleanupResult | undefined;
    try {
      done = await this.d.cleanup({ ...this.agent, runtime: "local" });
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.slug }, "reaping the previous process failed");
      // The slot and the cleanup target first: a failing DB write below must not free the slot of a running process.
      this.keepSlotAfterFailedStart = true;
      this.slots.stopFailed(this.agent.id);
      this.procRuntime = "local"; // Restart's cleanup reaps the journal again
      const message = previousProcessMessage(j?.claude?.pid);
      const logFailure = (e: unknown) =>
        this.d.log.error({ err: e, agent: this.agent.slug }, "recording stop_failed failed");
      // setErrored sets the in-memory truth first; the DB may be what failed.
      await this.setErrored(message, "stop_failed").catch(logFailure);
      await this.append(null, { type: "error", source: "spawn", message }).catch(logFailure);
      this.publishStatus();
      throw new AgentStartError(message);
    }
    if (done?.killedProcesses) this.carriedPids = pids;
    if (done) await this.append(null, { type: "cleanup", ...done });
  }

  /** A start failure before the launch: an `error` event and errored `start`, then the start error is thrown. */
  private async failStart(err: unknown, what: string): Promise<never> {
    throw await this.recordStartFailure(err, what);
  }

  /** The `error` event and errored `start` of a failed start; returns the error to throw. */
  private async recordStartFailure(err: unknown, what: string): Promise<AgentStartError> {
    const known = err instanceof AgentStartError;
    const message = known ? err.message : "The agent couldn't be prepared to start.";
    if (!known) this.d.log.error({ err, agent: this.agent.slug }, what);
    await this.append(null, {
      type: "error",
      source: "spawn",
      message,
      ...(known && err.fix ? { fix: err.fix } : {}),
    });
    await this.setErrored(message, "start");
    this.publishStatus();
    return known ? err : new AgentStartError(message);
  }

  /** An invariant: prepareStart refuses a Docker start without the container manager. */
  private dockerDeps(): DockerDeps {
    if (!this.d.docker) throw new Error("a Docker start without the Docker runtime configured");
    return this.d.docker;
  }

  /**
   * `ContainerManager.ensure` (create or re-create by spec hash, start, ready marker) with the mounts and the very
   * mount-check context `prepare` used, so the manager re-checks them right before the create or start. A failure is
   * a start failure, and a container this start may have started is stopped (spec §5.2).
   */
  private async ensureContainer(
    spec: AgentRuntimeSpec,
    launch: PreparedSpec["launch"],
  ): Promise<(EnsureResult & { image: string }) | undefined> {
    // Invariants, outside the Docker error mapping: a programming error must not read as a Docker fault.
    const docker = this.dockerDeps();
    if (!launch) throw new Error("a Docker start was prepared without its launch");
    try {
      const r = await docker.containers.ensure({
        agentId: this.agent.id,
        slug: this.agent.slug,
        image: launch.image,
        mounts: spec.mounts,
        mountCheck: launch.mountCheck,
      });
      return { ...r, image: launch.image };
    } catch (err) {
      // Removed after it was seen (spec §11.2): forget it and send the wake back through the pull, once per launch.
      // `ensure` throws this before any create or start, so there is no container to stop.
      if (err instanceof ImageMissingError) {
        // Always forgotten, so whichever wake comes next checks and pulls it again.
        docker.onImageMissing?.(err.image);
        if (!this.imageRequeued) {
          this.imageRequeued = true;
          return undefined;
        }
      }
      // A mount refused by the re-check keeps its own message ("Mount <path> isn't allowed: <reason>.").
      const startErr =
        err instanceof WorkspaceError
          ? new AgentStartError(err.message, err.fix)
          : dockerStartError(err);
      // The start failure first; a container stop that then fails makes it stop_failed (spec §9.6). The stop runs
      // even when recording the failure throws (the DB), so the container never outlives the start.
      try {
        throw await this.recordStartFailure(startErr, "starting the container failed");
      } finally {
        await this.stopUnlaunchedContainer();
      }
    }
  }

  /**
   * Stops the container of a start that didn't launch (spec §5.2). False when the stop failed: the agent is then
   * `stop_failed` and keeps its slot (spec §9.6), so the slot isn't counted free while the container may run.
   */
  private async stopUnlaunchedContainer(): Promise<boolean> {
    try {
      await this.d.docker?.containers.stopIfRunning(this.agent.id, this.agent.slug);
      return true;
    } catch (err) {
      this.d.log.error(
        { err, agent: this.agent.slug },
        "stopping the container of a start that didn't launch failed",
      );
      // The slot and the cleanup target first: a failing DB write below must not free the slot of a running container.
      this.keepSlotAfterFailedStart = true;
      this.slots.stopFailed(this.agent.id);
      this.procRuntime = "docker"; // Restart's cleanup stops (or removes) this container, whatever ran last
      // setErrored sets the in-memory truth first; the DB may be what failed.
      await this.setErrored(stopFailedMessage(undefined), "stop_failed").catch((e) =>
        this.d.log.error({ err: e, agent: this.agent.slug }, "recording stop_failed failed"),
      );
      this.publishStatus();
      return false;
    }
  }

  /** Restart's last resort for Docker (spec §9.6): force-remove the container. False when it failed too. */
  private async removeContainer(): Promise<boolean> {
    if (this.cleanupTarget().runtime !== "docker" || !this.d.docker) return false;
    try {
      await this.d.docker.containers.forceRemove(this.agent.id, this.agent.slug);
      return true;
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.slug }, "removing the container failed");
      return false;
    }
  }

  /** The agent as the cleanup port sees it: with the runtime its last process ran under. */
  private cleanupTarget(): AgentRow {
    return { ...this.agent, runtime: this.runningRuntime() };
  }

  /** The runtime of the last launched process (a re-sync may have changed the row's since), else the row's. */
  private runningRuntime(): "local" | "docker" {
    return this.procRuntime ?? this.agent.runtime;
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
    // setErrored sets the in-memory truth first; the DB may be the thing that failed.
    await this.setErrored("Internal error while recording the session", "internal").catch(() => {});
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
        // An errored agent's error clears only when its attempt succeeds (spec §9.2), not at session_started.
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
        // The attempt's batch turn (spec §9.2): the first origin-less turn_end after its batch was written.
        if (!e.originKind && this.attempting && this.attemptBatchWritten && this.started)
          await this.attemptSucceeded();
        this.openTurnId = undefined;
        this.lastActivityAt = Date.now();
        await this.oweNoticeIfCutOff();
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
      case "rate_limited":
        await this.append(this.openTurnId, e);
        this.rateLimitedTurn = true;
        await this.pauseCredential(e);
        break;
      case "background_task_started":
        await this.append(this.openTurnId, e);
        await this.snapshotJournal(proc); // its process may detach from Claude's tree later
        break;
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
          // Spec §9.3: the failed result of whichever attempt started it; never an automatic attempt of its own.
          const code = e.code !== undefined ? Number(e.code) : Number.NaN;
          const kind: ErrorKind =
            e.source === "spawn"
              ? "start"
              : classifyResumeFailure(e.message, Number.isInteger(code) ? code : undefined) ===
                  "unrecoverable"
                ? "resume_unrecoverable"
                : "resume";
          await this.setErrored(e.message, kind);
          this.failingProc = proc;
          // A hibernate under way (stop(), a shutdown) keeps its intent: its exit still does what it must. Any other
          // intent (a restart's) becomes failed_start, so the exit of the failed start never wakes the errored agent.
          if (this.afterExit?.kind !== "hibernate") {
            this.stopping = true;
            this.afterExit = { kind: "failed_start" };
            this.watchStop(proc, proc.stop({ graceMs: 1000 }), "failed start stop failed");
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
    const attemptOwed = this.attemptOwedAtExit; // only this process's exit honours it
    this.attemptOwedAtExit = false;
    if (this.escalationTimer) clearTimeout(this.escalationTimer);
    this.escalationTimer = undefined;
    // Spec §9.1: no recorded intent and not expected, whether or not the agent is errored or attempting.
    const crash = !intent && !e.expected;
    // Leftovers are cleaned up after a crash, an escalation and a Restart's force stop (spec §9.2, §9.6, §9.7, §12).
    const forced = crash || intent?.kind === "restart" || this.escalated.has(proc);
    const lost = this.lostSnapshot(); // before the tasks and crons are reset below
    // A hibernate that cut work short (in practice shutdown or archive: the others wait for idle) also reaps: a
    // `setsid` task outlives Claude's exit, and its journal is cleared below (spec §12, §18.3: nothing survives close).
    const cutShort =
      intent?.kind === "hibernate" && (intent.lost.tasks.length > 0 || lost.tasks.length > 0);
    const reap = forced || cutShort;
    // Docker: every exit stops the container before the slot goes back (spec §5.2, §6.4, §11.3): Claude's exit
    // leaves `sleep infinity` and any background process running in it.
    const docker = this.cleanupTarget().runtime === "docker";
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
    // A batch written after session_started whose turn hadn't begun: delivered but never answered (lost work).
    const batchUnanswered = this.awaiting.length > 0;
    this.awaiting = [];
    if (this.proc === proc) this.proc = undefined;
    this.started = false;
    const live = { turnOpen: Boolean(openTurnId), batchUnanswered, lost };
    const policy = crash ? this.onCrash(e, live) : "none";
    let keepSlot = false;
    try {
      if (reap || docker) keepSlot = !(await this.cleanUpLeftovers(crash, forced));
      else this.journalProc = undefined; // a clean exit: nothing of it is left to reap
      await this.oweNoticeIfCutOff(); // the exit ended a turn the rate limit cut off
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
      if (intent?.kind === "restart") await this.reportLostWork("restart", lost);
      if (policy !== "none" && policy !== "hibernated")
        await this.recordCrash(e, policy, live, keepSlot);
      // A crash keeps the journal's tasks and crons (the lost work is reported from them); a reap drops its pids.
      if (!crash) await this.writeJournal();
      else await this.persistJournal();
    } finally {
      this.publishQueue();
      // Every exit gives the slot back once it is recorded (spec §5.2), even when recording failed; a crash whose
      // cleanup failed keeps it (stop_failed, §9.6).
      if (!keepSlot) this.slots.release(this.agent.id);
    }
    if (keepSlot) {
      // The cleanup failed: stop_failed (§9.6), no wake; a Restart's attempt ends here.
      if (this.attemptReason) await this.endAttemptIfNothingStarts(this.attemptReason);
      return;
    }
    // failed_start and internal never wake; a crash makes one automatic attempt only when work was lost (§9.2).
    const canAttempt = !keepSlot && this.stopsInProgress === 0 && !this.slots.closing();
    if (policy === "recover" && !keepSlot) {
      if (canAttempt) await this.beginAttempt("crash_recovery", false);
    } else if ((intent?.kind === "failed_start" || intent?.kind === "internal") && attemptOwed) {
      // A human's message arrived while the failing process was still exiting (spec §9.2 step 5).
      if (canAttempt && this.messageStartsAttempt() && this.queue.length)
        await this.beginAttempt("message", false);
    } else if (intent?.kind === "hibernate") {
      if (intent.reason !== "shutdown" && intent.reason !== "archived")
        await this.wakeAfterExit(
          intent.reason === "apply_changes" && intent.lost.crons.length
            ? "apply_changes"
            : "queued_items",
        );
    } else if (intent?.kind === "restart" && this.attempting && this.attemptReason) {
      // Restart or Start a new session: the attempt's wake; if none can start now, the attempt ends.
      const reason = this.attemptReason;
      await this.wakeAfterExit(reason);
      await this.endAttemptIfNothingStarts(reason);
    }
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
    if (reason !== "warm_window" && reason !== "freed_slot")
      await this.reportLostWork(reason, lost);
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

  /** Spec §9.4: `background_work_lost` and the log line naming the manager, when live tasks or crons died. */
  private async reportLostWork(
    reason: "crash" | "restart" | Exclude<HibernateReason, "warm_window" | "freed_slot">,
    lost: LostWork,
  ) {
    if (!lost.tasks.length && !lost.crons.length) return;
    await this.append(null, { type: "background_work_lost", reason, ...lost });
    this.d.log.info(
      { agent: this.agent.slug, manager: this.agent.reportsTo, reason, ...lost },
      "background work lost; would notify the manager",
    );
  }

  /**
   * Inside the reload job, after the agent moved to another credential. The owed continue notice belonged to the
   * old credential's reset, which finds owed agents by their current credential: the flag is cleared rather than
   * left stranded (its text, "the rate limit on credential X reset", may not be true yet). Deliveries held by the
   * old pause go out now when the new credential isn't paused.
   */
  private async onCredentialChanged() {
    this.rateLimitedTurn = false;
    if (this.agent.rateLimitNoticeOwed) {
      await this.d.store.setNoticeOwed(this.agent.id, false);
      this.agent = { ...this.agent, rateLimitNoticeOwed: false };
      this.d.log.info(
        { agent: this.agent.slug },
        "credential changed while a continue notice was owed; the notice is dropped",
      );
    }
    if (this.proc) await this.flushOrStop("flush after a credential change failed");
  }

  /** A flush outside an API job: a failure with a process stops it (spec §11); without one it is only logged. */
  private async flushOrStop(what: string) {
    try {
      await this.flush();
    } catch (err) {
      if (this.proc) await this.onJobFailure(this.proc, err);
      else this.d.log.error({ err, agent: this.agent.slug }, what);
    }
  }

  /**
   * Spec §7.2: `resetsAt` (epoch seconds) is the window's end; missing, unparseable or past → 30 minutes, inexact.
   * The stored window may be longer (a later event extends, never shortens): the event reports the one in force.
   */
  private async pauseCredential(e: Extract<HarnessEvent, { type: "rate_limited" }>) {
    const now = Date.now();
    const reported = Number.isFinite(e.resetsAt) ? e.resetsAt * 1000 : Number.NaN;
    const exact = reported > now;
    if (!exact)
      this.d.log.warn(
        { agent: this.agent.slug, resetsAt: e.resetsAt },
        "rate limit reached but no reset time was reported; retrying in 30 minutes",
      );
    const p = await this.d.store.pauseCredential(
      this.agent.credentialId,
      new Date(exact ? reported : now + RATE_LIMIT_FALLBACK_MS),
      exact,
    );
    await this.append(this.openTurnId, {
      type: "rate_limit_paused",
      credential: p.name,
      until: p.until.toISOString(),
      exact: p.exact,
    });
    this.slots.pause(this.agent.credentialId, p.until, p.exact);
  }

  /** Spec §7.3: a turn that saw a `rate_limited` event ended; owe one continue notice unless one is owed already. */
  private async oweNoticeIfCutOff() {
    if (!this.rateLimitedTurn) return;
    this.rateLimitedTurn = false;
    if (this.agent.rateLimitNoticeOwed) return;
    await this.d.store.setNoticeOwed(this.agent.id, true);
    this.agent = { ...this.agent, rateLimitNoticeOwed: true };
  }

  /**
   * The crash policy (spec §9.2), decided synchronously so the in-memory state is right even if recording fails:
   * a crash during an attempt fails it; a crash that lost nothing is a plain hibernation; anything else is errored
   * and recovered by one automatic attempt.
   */
  private onCrash(
    e: Extract<HarnessEvent, { type: "exited" }>,
    live: CrashLive,
  ): "attempt_failed" | "hibernated" | "recover" {
    // The same order as the crash notice: the signal when there is one, else the exit code.
    const message = e.signal
      ? `Exited unexpectedly (${e.signal})`
      : e.code !== null
        ? `Exited unexpectedly (code ${e.code})`
        : "Exited unexpectedly";
    const policy = this.attempting
      ? "attempt_failed"
      : !live.turnOpen &&
          !live.batchUnanswered &&
          !live.lost.tasks.length &&
          !live.lost.crons.length &&
          !this.queue.length
        ? "hibernated"
        : "recover";
    if (policy === "hibernated") return policy;
    this.errored = true;
    this.lastError = message;
    this.errorKind = "crash";
    this.attempting = false;
    this.attemptReason = undefined;
    return policy;
  }

  /**
   * Spec §9.2 step 1 (and §9.6, §9.7): clean up leftovers first; a local reap clears the journal's pids. False when it
   * failed (the agent is then `stop_failed`, §9.6, and the journal keeps its pids for a later try).
   */
  private async cleanUpLeftovers(crash: boolean, record = true): Promise<boolean> {
    let done: CleanupResult | undefined;
    try {
      done = await this.d.cleanup?.(this.cleanupTarget());
    } catch (err) {
      const what = crash ? "cleanup after a crash failed" : "cleanup after a stop failed";
      // The cause names its source (e.g. the DB read of the journal, the Docker API), not only "the process".
      const why = err instanceof Error ? `: ${err.message}` : "";
      this.d.log.error({ err, agent: this.agent.slug }, `${what}${why}`);
      await this.setErrored(stopFailedMessage(undefined), "stop_failed");
      this.slots.stopFailed(this.agent.id);
      return false;
    }
    this.journalProc = undefined;
    this.carriedPids = [];
    // `cleanup` records leftovers after a crash, an escalation or a Restart (spec §15), not a hibernate's stop.
    if (done && record) await this.append(null, { type: "cleanup", ...done });
    return true;
  }

  /**
   * The durable side of the crash policy: errored (unless a failed cleanup made it stop_failed), the lost work
   * (spec §9.4, always), and for a recovery the crash notice (not when the cleanup failed: no attempt follows).
   */
  private async recordCrash(
    e: Extract<HarnessEvent, { type: "exited" }>,
    policy: "attempt_failed" | "recover",
    live: CrashLive,
    cleanupFailed: boolean,
  ) {
    if (!cleanupFailed)
      await this.d.store.setErrored(
        this.agent.id,
        this.lastError ?? "Exited unexpectedly",
        "crash",
      );
    const { tasks, crons } = live.lost;
    await this.reportLostWork("crash", live.lost);
    if (policy === "attempt_failed" || cleanupFailed) return; // only a human acts next
    await this.addNotice(
      "crash",
      notices.crash({
        exit: { code: e.code, signal: e.signal },
        duringTurn: live.turnOpen,
        tasks: tasks.map((t) => t.description || t.taskId),
        crons: crons.map((c) => c.humanSchedule),
      }),
    );
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
    // An attempt in progress finishes first; its success ends with a turn_end, which calls this again.
    if (!this.restartPending || this.errored || this.attempting) return;
    this.beginHibernate("apply_changes");
  }

  /**
   * Internal primitive, call only inside this agent's own job (spec §6.4). Records the intent and starts the stop
   * without awaiting it; the `exited` job does the rest. False when refused.
   */
  private beginHibernate(
    reason: HibernateReason,
    opts: { graceMs?: number; termWaitMs?: number } = { graceMs: 3000, termWaitMs: 10_000 },
  ): boolean {
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
    this.watchStop(proc, proc.stop(opts), "hibernate stop failed");
    return true;
  }

  /** Internal primitive, call only inside this agent's own job: stop the current process now, never awaited. */
  private beginForceStop(
    intent: AfterExit,
    opts: { graceMs: number; termWaitMs?: number } = { graceMs: 0 },
  ): void {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    this.afterExit = intent;
    this.watchStop(proc, proc.stop(opts), "force stop failed");
  }

  /** Observes a deliberate stop outside the job (never awaited in one): a timed-out stop escalates (spec §9.6). */
  private watchStop(proc: HarnessProcess, stopping: Promise<ExitInfo>, what: string): void {
    void stopping.then(
      (r) => {
        if (r.timedOut) void this.escalate(proc);
      },
      (err) => this.d.log.error({ err, agent: this.agent.slug }, what),
    );
  }

  /** One escalation job per process (a hibernate and a stop() taking it over share it). Never rejects. */
  private escalate(proc: HarnessProcess): Promise<void> {
    let p = this.escalations.get(proc);
    if (!p) {
      p = this.run(() => this.escalateNow(proc)).catch((err) =>
        this.d.log.error({ err, agent: this.agent.slug }, "stop escalation failed"),
      );
      this.escalations.set(proc, p);
    }
    return p;
  }

  /**
   * Spec §9.6, inside a job: the stop timed out, so SIGKILL (local) or stop the container (Docker), then the exit's
   * own job runs with the recorded intent. A failed escalation, or no exit within 5 s, is `stop_failed`.
   */
  private async escalateNow(proc: HarnessProcess, o: { removeOnFailure?: boolean } = {}) {
    if (proc !== this.proc) return; // its exit was recorded meanwhile
    const how = this.cleanupTarget().runtime === "docker" ? "container_stop" : "sigkill";
    this.d.log.warn({ agent: this.agent.slug, pid: proc.pid, how }, "stop timed out; escalating");
    await this.append(null, { type: "stop_escalated", how }).catch((err) =>
      this.d.log.error({ err, agent: this.agent.slug }, "recording stop_escalated failed"),
    );
    this.escalated.add(proc); // even a failed one: whenever it exits, the exit reaps
    try {
      await proc.forceKill();
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.slug, pid: proc.pid }, "escalation failed");
      // Restart of a stop_failed Docker agent (spec §9.6): the container stop failed again, so remove it, which
      // ends the exec stream and with it the process.
      if (!(o.removeOnFailure && (await this.removeContainer()))) {
        await this.markStopFailed(proc);
        return;
      }
    }
    if (proc !== this.proc) return;
    if (this.escalationTimer) clearTimeout(this.escalationTimer);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void this.run(async () => {
        if (this.escalationTimer !== timer) return;
        this.escalationTimer = undefined;
        if (proc === this.proc) await this.markStopFailed(proc);
      }).catch((err) => this.d.log.error({ err, agent: this.agent.slug }, "stop_failed failed"));
    }, ESCALATION_EXIT_MS);
    this.escalationTimer = timer;
  }

  /**
   * Spec §9.6: errored `stop_failed`, keeping the slot (a process may still run). A late exit releases the slot,
   * never wakes (intent `internal`) and leaves the agent errored. The Supervisor stops counting it as on its way out.
   */
  private async markStopFailed(proc: HarnessProcess) {
    this.deadProc = proc;
    this.afterExit = { kind: "internal" };
    this.restartPending = false;
    this.d.log.error({ agent: this.agent.slug, pid: proc.pid }, "the process can't be stopped");
    // setErrored sets the in-memory truth first; the DB may be what failed.
    await this.setErrored(stopFailedMessage(proc.pid), "stop_failed").catch(() => {});
    // Restart of a stop_failed agent makes one more escalation try (spec §9.6): don't cache this one.
    this.escalations.delete(proc);
    this.slots.stopFailed(this.agent.id);
    this.publishStatus();
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

  /** Writes runtime_journal's tasks and crons (spec §12) from the live state, merged with the process part. */
  private async writeJournal() {
    this.journalWork = this.lostSnapshot();
    await this.persistJournal();
  }

  /**
   * One write of the whole column (spec §12): the tasks/crons part and the local process part, when either changed;
   * cleared once both are empty.
   */
  private async persistJournal() {
    const { tasks, crons } = this.journalWork;
    const proc = withCarried(this.journalProc, this.carriedPids);
    const body = proc || tasks.length || crons.length ? { ...proc, tasks, crons } : null;
    const json = JSON.stringify(body);
    if (json === this.journalJson) return;
    await this.d.store.setRuntimeJournal(
      this.agent.id,
      body ? { ...body, takenAt: new Date().toISOString() } : null,
    );
    this.journalJson = json;
  }

  /**
   * Local only (spec §12): snapshot Claude's process tree into the journal. Best effort: a failure (the process just
   * exited, `ps` or the DB failed) is logged and never stops the agent.
   */
  private async snapshotJournal(proc: HarnessProcess) {
    const journal = this.d.journal;
    if (!journal || this.runningRuntime() !== "local" || proc !== this.proc) return;
    if (proc.pid === undefined) return;
    try {
      const snap = await journal.snapshot(proc.pid);
      this.journalProc = mergeSnapshot(this.journalProc, snap);
      await this.persistJournal();
    } catch (err) {
      this.d.log.warn(
        { err, agent: this.agent.slug, pid: proc.pid },
        "process journal snapshot failed",
      );
    }
  }

  /** Every 10 s while a turn is open or a background task is live: the only ways a descendant outlives Claude. */
  private updateSnapshotTimer() {
    const busy = Boolean(this.openTurnId) || this.liveTasks.size > 0;
    if (!this.d.journal || this.runningRuntime() !== "local" || !this.proc || !busy) {
      if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
      return;
    }
    if (this.snapshotTimer) return;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void this.run(async () => {
        if (this.snapshotTimer !== timer) return;
        this.snapshotTimer = undefined; // the end of this job arms the next one while still busy
        if (this.proc) await this.snapshotJournal(this.proc);
      }).catch((err) =>
        this.d.log.error({ err, agent: this.agent.slug }, "journal snapshot job failed"),
      );
    }, JOURNAL_SNAPSHOT_MS);
    this.snapshotTimer = timer;
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

  /**
   * Strict FIFO from the head while allowed (spec §8.3). Never starts a process. Holds everything during a stop and
   * while the credential is paused (spec §7.2; an urgent interrupt is written outside the flush).
   */
  private async flush() {
    while (
      this.proc &&
      !this.stopping &&
      !this.credentialPaused() &&
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
    if (this.attempting) this.attemptBatchWritten = true;
    if (!this.started) this.inFlight.push(batch);
    if (!turnAtWrite) this.awaiting.push(ids);
    this.publishQueue();
    return true;
  }
}
