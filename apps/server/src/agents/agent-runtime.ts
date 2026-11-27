import { randomUUID } from "node:crypto";
import type { MessageRow, RuntimeJournal } from "@open-factory/db";
import {
  type AgentRuntimeSpec,
  type BatchRow,
  type ExitInfo,
  type FactoryMessage,
  groupEnvelopes,
  type HarnessDriver,
  type HarnessProcess,
  type LiveEvent,
  neutraliseEnvelopeTags,
  ProcessNotRunningError,
} from "@open-factory/harness";
import {
  type AgentStatus,
  type AgentStatusFrame,
  type AnyEvent,
  type ConfigSnapshot,
  describeChanges,
  type Envelope,
  type ErrorKind,
  errorKindSchema,
  type FactCode,
  factoryZoneDefault,
  formatOffsetIso,
  type HarnessEvent,
  type LiveCron as LiveCronView,
  type LiveFrame,
  liveKey,
  type MessageKind,
  type QueueItem,
  REQUEST_KINDS,
  type RequestRef,
  statusOf,
  taskKey,
  type WaitingOn,
} from "@open-factory/shared";
import { type MentionPrincipal, mentionOf, renderMentions } from "@open-factory/shared/mentions";
import { LOCAL_RUNTIME_DISABLED } from "../config.ts";
import type { AgentTokens } from "../mcp/tokens.ts";
import { type FactDetail, type Forward, factFor } from "../messaging/forwarder.ts";
import { peerLeftOf } from "../messaging/peer-body.ts";
import type { AgentRecord } from "../principals/principal-store.ts";
import {
  type ContainerManager,
  type EnsureResult,
  ImageMissingError,
} from "../runtime/docker/containers.ts";
import { dockerStartError } from "../runtime/docker/errors.ts";
import type { SlotPort, WakeReason } from "../supervisor/slots.ts";
import { WorkspaceError } from "../workspace/links.ts";
import { capText } from "./cap.ts";
import type { Effective } from "./config-resolver.ts";
import {
  AgentArchivedError,
  AgentStartError,
  AgentTerminatedError,
  CommandsUnsupportedError,
  CompactingError,
  forSpawnedAgent,
  NoOpenTurnError,
  RecoveryRefusedError,
  SelfCommandPendingError,
  type StartFix,
  StopCronsError,
} from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, PendingRow, Tx } from "./event-store.ts";
import { liveCredentialId } from "./live-credential.ts";
import { type LiveFrameBody, LiveState } from "./live-state.ts";
import {
  AgentEndedError,
  AlreadyDeliveredError,
  assertSender,
  NotSenderError,
} from "./message-cancel.ts";
import { type NoticeType, notices } from "./notices.ts";
import { classifyResumeFailure } from "./resume-failure.ts";
import { SerialQueue } from "./serial-queue.ts";
import type { PreparedSpec, StartPreparer } from "./start.ts";

export interface RuntimeLog {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RuntimeDeps {
  agent: AgentRecord;
  store: EventStore;
  bus: EventBus;
  driver: HarnessDriver;
  /** Builds the spec for a process start. It takes the agent's ref lock itself: never call it while holding that lock. */
  prepareStart: StartPreparer;
  /** Per-launch agent tokens (spec §5.2): minted before each start, revoked when that process exits. */
  tokens: Pick<AgentTokens, "mint" | "revoke">;
  log: RuntimeLog;
  holdTimeoutMs?: number;
  /** The Supervisor's slot port (spec §5.2), which also owns the credential pauses (§7). */
  slots: SlotPort;
  /**
   * Cleans up what a crashed process left (spec §9.2 step 1): local, the journal reap (§12); Docker, the
   * container stop (§11.3). Resolves what it did (recorded as a `cleanup` event); a throw means a container stop
   * failed, which makes the agent `stop_failed` (§9.6). Defaults to a no-op.
   */
  cleanup?: (agent: AgentRecord) => Promise<CleanupResult | undefined>;
  /**
   * Local agents only (spec §12): snapshots Claude's process tree (pids with start times) into `runtime_journal`, so
   * the cleanup can reap what a dead process left. Absent with a fake driver: a fake pid is not ours to journal.
   */
  journal?: { snapshot(claudePid: number): Promise<ProcessPart> };
  /** The local gate (`config.allowLocalRuntime`), read live because it can change; defaults to allowed. */
  localRuntimeAllowed?: () => boolean;
  /** The Docker launcher (spec §10 step 4, §11): the one ContainerManager and the in-container Claude path. */
  docker?: DockerDeps;
  /**
   * S6 §8.1: how long the oldest pending member update waits while no turn is open (default 30 s; 0 = at once). Read
   * live (S10 §8.2, the `member_update_debounce_seconds` factory setting); `settingsChanged()` re-arms on a change.
   */
  memberUpdateDebounceMs?: () => number;
  /**
   * S10 §8.2: the factory default warm window in minutes, read live, for a started config that omits `warmWindowMinutes`
   * (70 when absent); `settingsChanged()` re-arms an armed warm timer on a change.
   */
  defaultWarmWindowMinutes?: () => number;
  /**
   * S6 §9.1: persists one forwarded item (the Router: a `member_update` to the manager, the `errored` fact to the
   * manager). Awaited inside the report's job: a failed insert is a failed event
   * write (§16). Only the hand-off to the manager is deferred. Tests that don't look at it pass `noForward`.
   */
  forward: (f: Forward) => Promise<void>;
}

export interface DockerDeps {
  containers: Pick<ContainerManager, "ensure" | "stopIfRunning" | "forceRemove" | "remove">;
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
  | "apply_changes"
  | "shutdown"
  | "archived"
  | "crons_stopped";

/** The live non-ambient tasks and crons a stop would kill (spec §9.4). */
export type LostWork = {
  tasks: { taskId: string; description: string }[];
  crons: { cronId: string; humanSchedule: string }[];
};

/** What the `exited` job must do, recorded when a deliberate stop begins (spec §5.5). */
export type AfterExit =
  | { kind: "hibernate"; reason: HibernateReason; lost: LostWork; by?: string }
  // Restart and Start a new session: the exit releases the slot and makes the attempt's wake, if one is on.
  | { kind: "restart"; by: string }
  | { kind: "terminate"; by: string } // S7 §8 step 3: its exit removes the container and never wakes
  | { kind: "failed_start" } // S3's stop after a spawn or resume failure
  | { kind: "internal" }; // S3's onJobFailure stop

/**
 * A pending message row (S6 §8): `from` is the envelope sender (`@factory`, `@scheduler`, else the sender's mention); `groupKey` the report a member update concerns; `about` the subject of a factory row; `subject` what
 * the UI needs for a peer event.
 */
type MessageEntry = {
  kind: "message";
  row: MessageRow;
  from: string;
  fromKind: "human" | "agent" | "factory";
  /** The sender's `<@ref>` mention, what a member update's `re` stores (absent for the factory and the scheduler). */
  fromMention?: string;
  /** A `message` row's recipients as `<@ref>` mentions (the envelope's `to`, rendered when it is written). */
  recipientMentions?: string[];
  groupKey?: string;
  /** The subject agent's `<@ref>` mention (the envelope's `about`). */
  about?: string;
  subject?: Subject;
};
/**
 * I1 §6.3 (D3): a written batch, kept until the turn that consumes it closes. `workingFor` answers from these, so a page
 * knows whose message a turn is working on from the write, long before `turn_started` or the stamp.
 */
type WrittenBatch = {
  ids: string[];
  /** Each row's human sender (`null` for an agent, a schedule, the factory). */
  senders: Map<string, string | null>;
  writtenAt: string;
  /** The id of each human's first `message` row in the batch. */
  firstIdBySender: Map<string, string>;
  /** The entries written, so a cut restart can put a batch whose turn never started back in the queue (I7 §9.2.1 step 4). */
  entries: MessageEntry[];
};
function writtenBatch(batch: MessageEntry[], writtenAt: string): WrittenBatch {
  const senders = new Map<string, string | null>();
  const firstIdBySender = new Map<string, string>();
  for (const { row, fromKind } of batch) {
    const human = fromKind === "human" ? row.fromId : null;
    senders.set(row.id, human);
    if (row.kind === "message" && human && !firstIdBySender.has(human))
      firstIdBySender.set(human, row.id);
  }
  return { ids: [...senders.keys()], senders, writtenAt, firstIdBySender, entries: batch };
}
/** The human senders of written batches, once each. */
function sendersOf(batches: WrittenBatch[]): string[] {
  const out = new Set<string>();
  for (const b of batches) for (const u of b.senders.values()) if (u) out.add(u);
  return [...out];
}
type CompactEntry = {
  kind: "compact";
  id: string;
  focus?: string;
  by: string;
  /** The human sender; an agent's entry (`send_command`) has none, so nobody can cancel it. */
  userId?: string;
  self?: boolean;
  createdAt: Date;
  clientMessageId?: string;
};
/**
 * I1 §5.1: raw session input (text or a slash command), in memory like a compact. `text` is written as typed, one user
 * line with no envelope; `by` is the sender's handle (`@orlevi`); `userId` is the human sender, the only one who may
 * cancel it (an agent's own entry, `self`, has none).
 */
type RawEntry = {
  kind: "raw";
  id: string;
  text: string;
  userId?: string;
  by: string;
  self?: boolean;
  createdAt: Date;
  clientMessageId?: string;
};
type Entry = MessageEntry | CompactEntry | RawEntry;
/** U3 §13.3: how many written command ids the runtime remembers, so a late Cancel says "already delivered". */
const WRITTEN_RAW_KEPT = 100;
/** U3 §13.3: how many (sender, clientMessageId) dispatches the runtime remembers, so a retry never runs twice. */
const RAW_RETRIES_KEPT = 200;

type Subject = NonNullable<Envelope["subject"]>;

const isNotice = (e: Entry): e is MessageEntry => e.kind === "message" && e.row.kind === "system";
const isPeer = (e: MessageEntry) => e.row.kind === "peer_joined" || e.row.kind === "peer_left";
/**
 * S9 §10.3, I2 §7.3, I9 §4.8: a queued item that never makes an agent wake, stay up or be kept alive by itself
 * (`crons_stopped`: the agent was stopped on purpose; `config_changed`: the change applies at the next start;
 * `report_config_changed` (I7 §8.2): a report's config change is information for a manager, never work; a peer event:
 * the neighborhood changed). It rides along with the next batch that has something else. The one predicate every
 * place that counts a queued item as a reason to act uses.
 */
const isPassive = (e: Entry): boolean =>
  e.kind === "message" &&
  (isPeer(e) ||
    (e.row.kind === "system" &&
      (e.row.notice === "crons_stopped" ||
        e.row.notice === "config_changed" ||
        e.row.notice === "report_config_changed")));
const kindOf = (row: MessageRow): MessageKind => row.kind as MessageKind;
const byCreated = (a: MessageEntry, b: MessageEntry) =>
  a.row.createdAt.getTime() - b.row.createdAt.getTime() || a.row.id.localeCompare(b.row.id);
const DEFAULT_MEMBER_UPDATE_DEBOUNCE_MS = 30_000;
/** setTimeout's largest delay; anything above it fires after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The only reasons that wake an errored agent (spec §5.2, §9.2); `message` is a human's and `member_updates` a report's
 * (I9 §4.8), each one attempt (notices never wake).
 */
const ERRORED_WAKES: ReadonlySet<WakeReason> = new Set([
  "crash_recovery",
  "restart",
  "reset",
  "message",
  "member_updates",
]);

/** The entry for a joined row (spec §7.3, §8.4); one shape for `init()`, `receive` and the deliveries. */
function entryOf(r: PendingRow): MessageEntry {
  const {
    fromHandle,
    fromRef,
    fromKind: senderKind,
    recipientMentions,
    subjectHandle,
    subjectRef,
    subjectDisplayName,
    ...row
  } = r;
  let from: string;
  let fromKind: MessageEntry["fromKind"] = "factory";
  if (row.kind === "system") from = "@factory";
  // S9: a scheduled row has no sender columns; it is from the scheduler (its author travels as `by`).
  else if (row.kind === "scheduled") from = "@scheduler";
  else if (fromHandle && senderKind) {
    from = `@${fromHandle}`;
    fromKind = senderKind;
  } else if (row.kind === "message") throw new Error(`message ${row.id} has no sender`);
  else from = "@factory";
  const groupKey = (senderKind === "agent" ? fromRef : null) ?? subjectRef ?? undefined;
  const entry: MessageEntry = {
    kind: "message",
    row,
    from,
    fromKind,
    ...(fromRef && senderKind ? { fromMention: mentionOf(fromRef) } : {}),
    ...(recipientMentions ? { recipientMentions } : {}),
    ...(groupKey ? { groupKey } : {}),
    ...(subjectRef ? { about: mentionOf(subjectRef) } : {}),
  };
  if ((row.kind === "peer_joined" || row.kind === "peer_left") && subjectHandle) {
    const left = row.kind === "peer_left" ? peerLeftOf(row.body) : undefined;
    entry.subject = {
      handle: subjectHandle,
      displayName: subjectDisplayName ?? subjectHandle,
      relation: row.notice === "report" ? "report" : "peer",
      ...(left ? { left } : {}),
    };
  }
  return entry;
}

const taskFieldsOf = (
  row: MessageRow & { taskNumber?: number | null; taskTitle?: string | null },
) => ({
  ...(row.taskNumber ? { taskKey: taskKey(row.taskNumber) } : {}),
  ...(row.taskTitle ? { taskTitle: row.taskTitle } : {}),
  ...(row.commentId ? { commentId: row.commentId } : {}),
});

/** S9: a `scheduled` row's envelope attributes; `due` carries the schedule zone's offset at that instant. */
const scheduleFieldsOf = (
  row: MessageRow & {
    scheduleKey?: string | null;
    scheduleZone?: string | null;
    authorMention?: string | null;
    authorKind?: "human" | "agent" | null;
  },
) =>
  row.kind === "scheduled" && row.scheduleKey
    ? {
        scheduleKey: row.scheduleKey,
        ...(row.authorMention ? { by: row.authorMention } : {}),
        ...(row.authorKind ? { byKind: row.authorKind } : {}),
        ...(row.dueAt ? { due: formatOffsetIso(row.dueAt, row.scheduleZone ?? "UTC") } : {}),
        ...(row.firings ? { firings: row.firings } : {}),
        ...(row.late ? { late: true } : {}),
      }
    : {};

const queueScheduleOf = (row: MessageRow & { scheduleKey?: string | null }) =>
  row.kind === "scheduled" && row.scheduleKey
    ? {
        scheduleKey: row.scheduleKey,
        ...(row.firings ? { firings: row.firings } : {}),
        ...(row.late ? { late: true } : {}),
        ...(row.dueAt ? { dueAt: row.dueAt.toISOString() } : {}),
      }
    : {};

/** The requests among written entries (REQUEST_KINDS), as the `re` of the updates the turn forwards. */
const requestsOf = (entries: MessageEntry[]): RequestRef[] =>
  entries
    .filter((e) => REQUEST_KINDS.has(kindOf(e.row)))
    .map((e) => ({ id: e.row.id, from: e.fromMention ?? e.from }));

const toBatchRow = (e: MessageEntry): BatchRow => ({
  id: e.row.id,
  kind: kindOf(e.row),
  // A principal is its mention here (rendered when the batch is written); the factory and the scheduler stay words.
  from: e.fromMention ?? e.from,
  fromKind: e.fromKind,
  ...(e.recipientMentions ? { to: e.recipientMentions } : {}),
  urgent: e.row.urgent,
  body: e.row.body,
  createdAt: e.row.createdAt,
  ...(e.about ? { about: e.about } : {}),
  ...(e.row.kind === "member_update" && e.row.re?.length ? { re: e.row.re } : {}),
  ...(e.groupKey ? { groupKey: e.groupKey } : {}),
  // A factory member update's fact code is its notice (spec §9.1).
  ...(e.row.kind === "member_update" && e.from === "@factory" && e.row.notice
    ? { fact: e.row.notice }
    : {}),
  ...(e.subject ? { subject: e.subject } : {}),
  // S8: a task message names its task; a `task_update`'s notice is its fact code (the UI keys on it, never on prose).
  ...taskFieldsOf(e.row),
  ...scheduleFieldsOf(e.row),
  ...(e.row.kind === "task_update" && e.row.notice ? { fact: e.row.notice } : {}),
  // U3 §13.2: a UI field on the envelope; never part of the text the model reads.
  ...(e.row.clientMessageId ? { clientMessageId: e.row.clientMessageId } : {}),
  // U3 §13.5: a UI field too; the body already carries the `[attached: …]` lines the model reads.
  ...(e.row.attachments?.length ? { attachments: e.row.attachments } : {}),
});

/** How long an escalated stop (SIGKILL, container stop) may take to produce the exit (spec §9.6). */
const ESCALATION_EXIT_MS = 5_000;
/** Spec §9.6's text; the pid, when known, is in the detail (the status line is just "Errored"). */
export const stopFailedMessage = (pid: number | undefined) =>
  `The agent's process can't be stopped. Check the host${pid ? ` (pid ${pid})` : ""} or Docker, then restart again.`;
/** A local start found the previous process's journal and couldn't reap it (spec §9.6, §12). */
const previousProcessMessage = (pid: number | undefined) =>
  `The agent's previous process couldn't be stopped. Check the host${pid ? ` (pid ${pid})` : ""}, then restart again.`;

/** A start refused because the agent was terminated (S7 §8 step 1): not recorded as a start failure. */
const TERMINATED_START = "The agent was terminated.";

/** The owed-notification bound (spec §6.1). */
const OWED_BOUND_MS = 30_000;
/** Local process-tree snapshots while a turn is open or a task is live (spec §12). */
const JOURNAL_SNAPSHOT_MS = 10_000;
/** The pause when a `rejected` rate limit reports no usable reset time (spec §7.2). */
const RATE_LIMIT_FALLBACK_MS = 30 * 60_000;
/** Claude expires an in-session cron 7 days after it was created (spec §6.2). */
const CRON_EXPIRY_MS = 7 * 24 * 3_600_000;
const DEFAULT_WARM_WINDOW_MINUTES = 70;

/**
 * The zone Claude's process runs in, which `humanSchedule` is written in (S9 §10.2): UTC in Docker (the base image sets
 * no `TZ`, and S9 passes none; follow-up #66), the server's resolved zone for a local agent.
 */
export const cronZoneOf = (runtime: "local" | "docker") =>
  runtime === "docker" ? "UTC" : factoryZoneDefault();

type LiveTask = { ambient: boolean; description: string; startedAt: number };
type LiveCron = {
  recurring: boolean;
  humanSchedule: string;
  nextFireAt: number;
  createdAt: number;
  /** From `CronCreate`'s result: whether the harness persisted it (S0/S9 V2: not in headless mode). */
  durable: boolean;
};

/**
 * Every batch goes through groupEnvelopes, the one owner of envelope-body escaping. Principals are mentions until now: one
 * query names every ref of the batch, and each attribute and body is rendered with its current handle (spec §4.4).
 */
async function toEnvelopes(
  batch: MessageEntry[],
  mentionLookup: (
    texts: readonly string[],
  ) => Promise<(ref: string) => MentionPrincipal | undefined>,
): Promise<FactoryMessage[]> {
  const rows = batch.map(toBatchRow);
  const texts = rows.flatMap((r) => [
    r.from,
    r.body,
    ...(r.to ?? []),
    ...(r.about ? [r.about] : []),
    ...(r.by ? [r.by] : []),
    ...(r.re?.map((x) => x.from) ?? []),
  ]);
  const lookup = await mentionLookup(texts);
  const show = (t: string) => renderMentions(t, lookup, "agent");
  return groupEnvelopes(
    rows.map((r) => ({
      ...r,
      from: show(r.from),
      body: show(r.body),
      ...(r.to ? { to: r.to.map(show) } : {}),
      ...(r.about ? { about: show(r.about) } : {}),
      ...(r.by ? { by: show(r.by) } : {}),
      ...(r.re ? { re: r.re.map((x) => ({ ...x, from: show(x.from) })) } : {}),
    })),
  );
}

/** I7 §9.2: what a `restartNow` did; it never waits for the start. */
export type RestartOutcome = {
  status: "restarting" | "restart_pending" | "not_running" | "restarted_idle";
  note?: string;
};

/** I7 §9.2 row 8: the refusal text, from what a forced restart would stop. */
const lostWorkMessage = (handle: string, lost: { tasks: string[]; crons: string[] }) => {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    ...(lost.tasks.length
      ? [
          `${plural(lost.tasks.length, "background task")} (${lost.tasks.map((t) => `\`${t}\``).join(", ")})`,
        ]
      : []),
    ...(lost.crons.length ? [plural(lost.crons.length, "cron")] : []),
  ];
  return `@${handle} has ${parts.join(" and ")}; pass force: true to restart anyway.`;
};

export class AgentRuntime {
  agent: AgentRecord;
  private readonly jobs = new SerialQueue();
  private proc: HarnessProcess | undefined;
  private deadProc: HarnessProcess | undefined;
  private sessionStarted = false; // session_started seen for this process
  private starting = false; // a start is between its API job and the spawn (prepare may be waiting on the ref lock)
  private openTurnId: string | undefined;
  /** U3 §5.2: when the open turn's `turn_started` was stored (ISO); set and cleared with `openTurnId`. */
  private turnStartedAt: string | undefined;
  /** The credential the live process was launched with (`reload()` may move the agent since); cleared on exit. */
  private procCredentialId: string | undefined;
  private lastUsage: Extract<HarnessEvent, { type: "usage" }> | undefined;
  private queue: Entry[] = [];
  /**
   * I9 §4.8: member updates handed over and still inside the debounce, in (created_at, id) order. When the oldest is
   * due they all enter `queue` as one batch and are delivered like a message; nothing else reads them.
   */
  private debounced: MessageEntry[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly seen = new Set<string>(); // every row id this runtime loaded or was handed (S6 §7.3)
  private inFlight: MessageEntry[][] = []; // written, waiting for session_started
  private awaiting: WrittenBatch[] = []; // written with no open turn, settled at the next turn_end
  private absorbed: WrittenBatch[] = []; // written into the open turn (already stamped with it)
  /**
   * The requests of the open turn, in write order: those the turn started with, then each one written into it. A
   * forwarded text carries the first `turnRequestsSeen` of them as `re`, so the manager can tell whose request it
   * answers. Claude reads a mid-turn write only at the next top-level tool boundary, so a request counts once a tool
   * result follows its write. Requests still unseen when the turn ends are what Claude runs as its next turn, so they
   * carry into it (`carriedRequests`). Empty in a self-started turn nothing reached.
   */
  private turnRequests: RequestRef[] = [];
  private turnRequestsSeen = 0;
  private carriedRequests: RequestRef[] = [];
  /** An exit's snapshot of `awaiting` and `absorbed` until its close settles, so `workingFor` never goes blank (I1 §6.3). */
  private closing: WrittenBatch[] | undefined;
  private compactInFlight = false;
  /** A manual `compact_failed` arrived while `compactInFlight`: whether Claude then sends the compact's own
   *  `turn_end{command: "compact"}` is unverified, so the next origin-less `turn_end` also ends the compact. */
  private compactFailedSeen = false;
  /**
   * I1 §6.3 (D3): the user's message a turn is working on, read synchronously for `GET /chat`. `key` is the id of the
   * user's first message in the batch (or, with none awaiting, the first absorbed into the open turn); `since` is that
   * batch's write time. Reports an exit's snapshot until its close settles.
   */
  workingFor(userId: string): { key: string; since: string } | null {
    for (const b of [...(this.closing ?? []), ...this.awaiting, ...this.absorbed]) {
      const key = b.firstIdBySender.get(userId);
      if (key) return { key, since: b.writtenAt };
    }
    return null;
  }

  /** I1 §5.1: a raw entry was written and its turn hasn't ended; nothing is written behind it (like a compact). */
  private rawInFlight = false;
  /** I1 §7: the written raw entry is the agent's own command. */
  private rawSelf = false;
  /** I1 §7: the agent's own `/compact` was written; `failed` once a `compact_failed` came after it. Gone on exit. */
  private selfCompact: { failed: boolean } | undefined;
  /** U3 §13.3: written commands' ids and senders (the newest few), for the Cancel that arrives too late. */
  private readonly writtenRaw = new Map<string, string>();
  /** U3 §13.3: `userId \0 clientMessageId` → the dispatch's entry, queued or written (the newest few). */
  private readonly rawRetries = new Map<string, RawEntry | CompactEntry>();
  private hold: ReturnType<typeof setTimeout> | undefined;
  private errored: boolean;
  private archived: boolean;
  // S7 §8 step 1: the termination latch, separate from `archived` (which reload reassigns from the row). Only ever OR'd
  // in from `terminated_at` and cleared only by `unmarkTerminated()`. `terminationCommitted`: the row says so (the
  // status shows it, arriving rows are rejected); a provisional latch only holds everything still.
  private terminated: boolean;
  private terminationCommitted: boolean;
  // Provisional latches not yet committed or undone: concurrent terminations (a tool call and a human) each set one,
  // and a failed one must not undo another still in flight.
  private provisionalLatches = 0;
  // What the first provisional latch held back, restored when the last one is undone.
  private restartPendingAtLatch = false;
  private pendingWakeAtLatch = false;
  private lastError: string | undefined;
  private errorKind: ErrorKind | undefined;
  // Spec §9.2: an attempt to bring back interrupted work is in progress (persisted). `attemptReason` is its wake's
  // reason (the only wake accepted meanwhile); the attempt succeeds at the first origin-less turn_end after a batch.
  private attempting: boolean;
  private attemptReason: WakeReason | undefined;
  private attemptBatchWritten = false;
  // A human's message (or a report's update) reached an errored agent whose failing process hadn't exited yet: attempt
  // at that exit, for this reason.
  private attemptOwedAtExit: WakeReason | undefined;
  // S6 §9.1 (R4): `errored` is forwarded at most once per errored episode, which runs until the error clears (an
  // attempt succeeds or Start a new session). Loaded from `errored_reported`, which the Router sets durably.
  private erroredForwarded: boolean;
  private readonly escalations = new WeakMap<HarnessProcess, Promise<void>>();
  private readonly tokenGens = new WeakMap<HarnessProcess, number>(); // the token generation each process was started with
  private readonly escalationRecorded = new WeakSet<HarnessProcess>();
  private readonly escalated = new WeakSet<HarnessProcess>(); // SIGKILLed or container-stopped: its exit reaps (§9.6)
  private escalationTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStatusJson = "";
  private submitted = 0;
  // Apply-restart (spec §13)
  private restartPending = false;
  /**
   * I7 §9.5: the pending restart is a self-edit's: its exit adds a waking `config_continue` notice and wakes the agent.
   * Set only with `restartPending` (by `requestRestart`), kept by Stop crons' takeover, and consumed or cleared by
   * every exit and every stop or takeover that clears `restartPending`, so a crash or archive never carries it.
   */
  private pendingWake = false;
  /** I2 §7.3: the change lines the pending restart applies (`restartChanges`); cleared on every exit and launch. */
  private pendingChanges = new Set<string>();
  /** I2 §7.2: the config lines of the pending restart, `describeChanges(started, current)`; replaced, never unioned. */
  private configChanges: string[] = [];
  /** A pending restart was also asked for by something other than a config change (credential, grants, manager). */
  private otherRestartCause = false;
  /**
   * I2 §6.2: the config the current process started with (`PreparedSpec.effective`), set at the launch and cleared at
   * its exit; undefined while nothing runs. Whatever describes the running process reads it. Holds env values: never log
   * it.
   */
  started: Effective | undefined;
  /**
   * I2 §7.3: the store-clock stamp taken before the current process's prepare. A `config_changed` row created after it
   * describes a change this process may not have, so it is held for the next process.
   */
  private procStartedAt: Date | undefined;
  /**
   * I2 §6.2: the image the next Docker start is expected to use, which the Supervisor's synchronous `refOf` checks and
   * pulls before the grant. Kept by `AgentRuntimes` for a loaded runtime (undefined when the template was invalid at
   * load) and refreshed on every config change; a start that resolves another image updates it and goes back through
   * the pull.
   */
  nextImage: string | undefined;
  /**
   * I7 §9.2.1: a cut restart is under way. While set, nothing is written to the old process (`flush`), whoever calls it.
   * Cleared by every exit and by `stop()`; the fallback is its bound (`holdTimeoutMs`), cleared with it.
   */
  private restartNowPending?: { by: string; changes: string[] | null };
  private restartNowFallback?: ReturnType<typeof setTimeout>;
  private stopping = false; // a deliberate stop of the current process began: flush() writes nothing
  /** S7 §8 step 5: the sweep's last Docker list showed a container left for this terminated agent. */
  private containerListed = false;
  private stopsInProgress = 0; // stop() calls not yet returned: no process may be spawned meanwhile
  private afterExit: AfterExit | undefined; // the intent of the stop in progress, consumed by the `exited` job
  private noStart = false; // the closing latch (spec §5.6): never launch again
  // The runtime of the last launched process (or of a container a start left that couldn't be stopped): its exit and
  // cleanup follow it, even if the row changed since.
  private procRuntime: "local" | "docker" | undefined;
  private runningImage: string | undefined; // Docker: the image the live process was started from
  // A start whose container couldn't be stopped (spec §9.6): stop_failed, and startNow must not give the slot back.
  private keepSlotAfterFailedStart = false;
  private readonly slots: SlotPort;
  private failingProc: HarnessProcess | undefined; // a start that failed (spawn/resume error) and is being stopped
  private liveTasks = new Map<string, LiveTask>(); // startedAt = first seen in a `background_tasks` set
  /** U3 §11.2: partial messages of the current process, in memory only; published as coalesced `live` frames. */
  private readonly liveState = new LiveState((body) => this.publishLive(body));
  /** A background task's tool call (`background_task_started`), so its finish clears that subagent's live line. */
  private taskToolUse = new Map<string, string>();
  private crons = new Map<string, LiveCron>(); // the live in-session crons (spec §6.2): pin the agent
  /** S9 §10.3: a Stop crons waiting for the first moment the agent isn't busy; `by` is the human's `@handle`. */
  private stopCronsPending: { by: string } | undefined;
  private stopCheckQueued = false;
  private owedNotifications = 0;
  private owedTimer: ReturnType<typeof setTimeout> | undefined;
  private warmTimer: ReturnType<typeof setTimeout> | undefined;
  private warmArmedAt: number | undefined; // when the armed warm timer's window began (S10 §8.2)
  private cronExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private cronExpiryAt: number | undefined;
  // runtime_journal (spec §12): the tasks/crons part and the local process part, merged into one write.
  private journalWork: LostWork = { tasks: [], crons: [] };
  private journalProc: ProcessPart | undefined;
  // Pids a pre-start reap signalled (spec §12): kept in the journal until a later reap, in case one survived.
  private carriedPids: ProcessPart["descendants"] = [];
  private journalJson = "null"; // what was last written, without takenAt
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitedTurn = false; // a `rate_limited` event since the last turn end (spec §7.3)
  /** The last turn end, delivery or start (spec §5.3). */
  lastActivityAt = Date.now();
  // S7 §10.3: the latest activity this runtime recorded (start, turn end, delivery); undefined until one happens. The
  // TTL check takes the later of it and the row's, so a lost `setLastActivity` write never gets an active agent reaped.
  private activityRecorded: number | undefined;

  constructor(private readonly d: RuntimeDeps) {
    this.agent = d.agent;
    this.errored = d.agent.status === "errored";
    this.erroredForwarded = d.agent.erroredReported;
    this.lastError = d.agent.lastError ?? undefined;
    const kind = errorKindSchema.safeParse(d.agent.errorKind);
    this.errorKind = kind.success ? kind.data : undefined;
    this.attempting = d.agent.attempting;
    this.archived = Boolean(d.agent.archivedAt);
    this.terminated = Boolean(d.agent.terminatedAt);
    this.terminationCommitted = this.terminated;
    this.slots = d.slots;
  }

  async init() {
    this.agentRefValue = await this.ref();
    // The row may have been terminated since it was read for the constructor.
    const r = await this.d.store.agentById(this.agent.id);
    if (r?.terminatedAt && !this.terminationCommitted) this.markTerminated({ committed: true });
    if (this.terminationCommitted) {
      // S7 §8: a terminated agent receives nothing. A row still pending to it (one that raced in during a crash window)
      // is rejected, never queued.
      this.chatChanged(await this.d.store.rejectPending(this.agent.id));
      return;
    }
    const pending = (await this.d.store.pendingQueue(this.agent.id)).map(entryOf);
    for (const e of pending) this.seen.add(e.row.id);
    // I9 §4.8, boot: pending member updates wait out their debounce again (the timer re-arms from the oldest, firing at
    // once when it is past). An errored agent's ride along with its recovery instead: loading it never starts an attempt.
    const debounce = (e: MessageEntry) => e.row.kind === "member_update" && !this.errored;
    this.queue = pending.filter((e) => !debounce(e));
    this.debounced = pending.filter(debounce).sort(byCreated);
    // Not a job, so the end-of-job hook doesn't cover it.
    this.armDebounceTimer();
  }

  /**
   * S6 §8, I9 §4.8: a member update or a peer event handed over after its commit, unless this runtime already has it.
   * An update waits out the debounce (`deliverDebounced`); a peer event is a passive item that rides along with the next
   * batch. Terminated (committed): the row is rejected. Archived: it just stays pending (spec §16's `rejected` rule is
   * about send_message, Router-side). A provisional latch keeps it unwritten (S7 §8 step 1).
   */
  receive(row: PendingRow): Promise<void> {
    return this.run(async () => {
      if (this.terminationCommitted) {
        if (!this.seen.has(row.id)) await this.d.store.markRejected(row.id);
        return;
      }
      if (this.seen.has(row.id) || this.archived) return;
      const entry = entryOf(row);
      this.seen.add(row.id);
      if (row.kind === "member_update") this.debounced = [...this.debounced, entry].sort(byCreated);
      else {
        this.insertByCreated(entry);
        this.publishQueue();
      }
    });
  }

  /**
   * I9 §4.8: the debounce of the oldest pending update has passed. Every pending update enters the queue as one batch
   * and is delivered as a report's message is: a wake (an errored agent makes one attempt, as for a human's message),
   * written mid-turn at the next tool boundary like any queued message.
   */
  private async deliverDebounced() {
    if (this.terminated || this.archived || !this.debounceDue()) return;
    for (const e of this.debounced.splice(0)) this.insertByCreated(e);
    this.publishQueue();
    await this.wakeToDeliver("member_updates", { attempts: true, inline: false });
    await this.flushOrStop("flush of member updates failed");
    this.publishStatus();
  }

  /** Whether the oldest pending update's debounce has passed (0: at once, even for a row stamped ahead). */
  private debounceDue(): boolean {
    const oldest = this.debounced[0];
    if (!oldest) return false;
    const debounce = this.debounceMs();
    return debounce === 0 || Date.now() >= oldest.row.createdAt.getTime() + debounce;
  }

  /**
   * I9 §4.8: one timer per runtime at the oldest pending update's due time, re-evaluated at the end of every job (and
   * by `init()`, the closing latch, archive and termination). Never throws.
   */
  private armDebounceTimer() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    const oldest = this.debounced[0];
    if (!oldest || this.noStart || this.archived || this.terminated) return;
    // 0 means at once, even for a row stamped a millisecond ahead (the store's stamps are strictly increasing).
    const debounce = this.debounceMs();
    const dueIn = debounce === 0 ? 0 : oldest.row.createdAt.getTime() + debounce - Date.now();
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => {
        void this.run(async () => {
          if (this.debounceTimer !== timer) return;
          this.debounceTimer = undefined;
          await this.deliverDebounced();
        }).catch((err) =>
          this.d.log.error({ err, agent: this.agent.handle }, "delivering member updates failed"),
        );
      },
      // Above setTimeout's maximum the delay overflows to 1 ms and the timer would spin: an early fire finds nothing
      // due and the end of its job re-arms for the rest (config caps the window at a day; this is the backstop).
      Math.min(Math.max(0, dueIn), MAX_TIMER_DELAY_MS),
    );
    this.debounceTimer = timer;
  }

  private debounceMs(): number {
    return this.d.memberUpdateDebounceMs?.() ?? DEFAULT_MEMBER_UPDATE_DEBOUNCE_MS;
  }

  /**
   * The wake of a delivery from inside a job. `attempts`: an errored agent makes one attempt (spec §9.2), or one at
   * its failing process's exit. `inline` for an API job (an immediate start failure rejects the call).
   */
  private async wakeToDeliver(reason: WakeReason, o: { attempts: boolean; inline: boolean }) {
    if (o.attempts && this.messageStartsAttempt()) return this.beginAttempt(reason, o.inline);
    if (o.attempts && this.messageMayAttempt() && this.proc) this.attemptOwedAtExit = reason;
    if (o.inline) await this.wakeInline(reason);
    else if (!this.proc) await this.wakeFromJob(reason);
  }

  // ---------- public API (each runs as a job) ----------

  /**
   * S6 §7.3: a committed `message` row handed over by the Router. Inserted in (created_at, id) order after the
   * notices unless this runtime already has it (`init()` may have loaded it); the wake, the urgent interrupt and the
   * flush run while it is still queued, and are skipped once it has already been written. Archived meanwhile: the row becomes `rejected`. Only a human's message starts an attempt on
   * an errored agent; another agent's wakes with `reason` (default `agent_message`; S7's brief: `spawned`), neither of
   * which wakes an errored one nor is ever an attempt.
   */
  deliver(
    row: PendingRow,
    o: { sender: "human" | "agent"; fromLabel: string; reason?: WakeReason },
  ): Promise<QueueItem> {
    return this.apiJob(async () => {
      if (this.terminationCommitted) {
        // S7 §8 step 2: the transaction rejected what was pending; a row handed over after it is rejected here.
        this.chatChanged([await this.d.store.markRejected(row.id)]);
        throw new AgentTerminatedError(this.agent.handle);
      }
      if (this.archived) {
        this.chatChanged([await this.d.store.markRejected(row.id)]);
        const at = this.queue.findIndex((e) => e.kind === "message" && e.row.id === row.id);
        if (at !== -1) {
          this.queue.splice(at, 1);
          this.publishQueue();
        }
        throw new AgentArchivedError(this.agent.handle);
      }
      let entry = this.queue.find(
        (e): e is MessageEntry => e.kind === "message" && e.row.id === row.id,
      );
      if (!this.seen.has(row.id)) {
        entry = entryOf(row);
        this.seen.add(row.id);
        this.insertByCreated(entry);
        this.publishQueue();
      } else if (!entry) {
        // Already written (boot reconciliation's wake loaded and delivered it while the Router waited on `booted`):
        // nothing to wake for, and an urgent interrupt now would stop the very turn reading it.
        return this.itemOf(entryOf(row));
      } else if (row.kind === "scheduled") {
        // S9 §8.2 rule 3: a firing replaced this still-queued row. Re-read it and take the stored version only if it
        // covers more firings, so an older hand-off arriving after `init()` loaded a newer one never regresses it.
        const fresh = await this.d.store.pendingJoined(row.id);
        if (!fresh) return this.itemOf(entry); // written meanwhile, or rejected: as for any seen id
        if ((fresh.firings ?? 0) > (entry.row.firings ?? 0)) {
          entry.row = fresh;
          this.publishQueue();
        }
      }
      // A provisional latch (S7 §8 step 1): queued and seen, but no wake, interrupt or flush. If the termination
      // fails, `unmarkTerminated` delivers it; if it commits, the transaction rejected it.
      if (this.terminated) return this.itemOf(entry ?? entryOf(row));
      // A human's message to an errored agent is one attempt (spec §9.2); notices never wake one.
      if (o.sender === "human")
        await this.wakeToDeliver("message", { attempts: true, inline: true });
      else await this.wakeInline(o.reason ?? "agent_message");
      if (row.urgent) await this.urgentInterrupt(o.fromLabel);
      await this.flush();
      return this.itemOf(entry ?? entryOf(row));
    });
  }

  /**
   * U3 §13.2: the queue item a repeated send answers with: the queued entry while it is still queued (so a Stop's
   * `waitReason` shows), otherwise the row's own.
   */
  itemFor(row: PendingRow): QueueItem {
    const queued = this.queue.find((e) => e.kind === "message" && e.row.id === row.id);
    return this.itemOf(queued ?? entryOf(row));
  }

  /**
   * At its (created_at, id) place, so concurrent sends keep their order: it moves ahead only of newer messages at the
   * tail, never of a notice or a compact (a barrier).
   */
  private insertByCreated(entry: MessageEntry) {
    let at = this.queue.length;
    for (; at > 0; at--) {
      const e = this.queue[at - 1];
      if (e?.kind !== "message" || isNotice(e) || byCreated(e, entry) < 0) break;
    }
    this.queue.splice(at, 0, entry);
  }

  /**
   * U3 §6.4 (Q26, D2): the sender withdraws a message nothing has written yet. Only their own `kind = 'message'` row
   * (`NotSenderError` otherwise), only while it is still in the queue (in flight, awaiting or written:
   * `AlreadyDeliveredError`), and the row changes only if it is still pending and unwritten. A wake already under way
   * is left alone. Resolves to the cancelled item; one already cancelled resolves to it again (idempotent).
   */
  cancelQueued(messageId: string, userId: string): Promise<QueueItem> {
    return this.apiJob(async () => {
      const cmd = this.cancelRaw(messageId, userId);
      if (cmd) return cmd;
      const row = await this.d.store.messageRow(messageId);
      assertSender(row, { agentId: this.agent.id, userId });
      // Already cancelled (a second tab, a retried DELETE): idempotent, the same item; it was never delivered.
      if (row.state === "cancelled")
        return this.itemOf(entryOf(await this.d.store.pendingRow(messageId)));
      const at = this.queue.findIndex((e) => e.kind === "message" && e.row.id === messageId);
      const entry = this.queue[at];
      if (!entry) throw new AlreadyDeliveredError();
      if (!(await this.d.store.cancelPending(messageId))) throw new AlreadyDeliveredError();
      this.queue.splice(at, 1);
      this.publishQueue();
      this.chatChanged([userId]);
      return this.itemOf(entry);
    });
  }

  /**
   * U3 §13.3 (Q39): a held command is the sender's to cancel, with no restore; another user gets `NotSenderError`, and
   * a written one `AlreadyDeliveredError` (for its sender). Undefined when `id` is no command's.
   */
  private cancelRaw(id: string, userId: string): QueueItem | undefined {
    const at = this.queue.findIndex((e) => e.kind === "raw" && e.id === id);
    const entry = this.queue[at];
    if (entry?.kind === "raw") {
      if (entry.userId === undefined || entry.userId !== userId) throw new NotSenderError();
      this.queue.splice(at, 1);
      this.publishQueue();
      return this.itemOf(entry);
    }
    const sender = this.writtenRaw.get(id);
    if (sender === undefined) return undefined;
    if (sender !== userId) throw new NotSenderError();
    throw new AlreadyDeliveredError();
  }

  /**
   * U3 §6.4: Undo of a cancel. The same sender check; `AgentEndedError` on a terminated or archived agent. The row is
   * pending again and goes back among the still-queued items by `createdAt` (next, if later ones were written
   * meanwhile), then wakes and flushes like a delivery, without the `seen` guard (its id is known) and never with an
   * urgent interrupt. A message that isn't cancelled is left as it is: still queued, a no-op; otherwise
   * `AlreadyDeliveredError`.
   */
  restoreQueued(messageId: string, userId: string): Promise<void> {
    return this.apiJob(async () => {
      assertSender(await this.d.store.messageRow(messageId), {
        agentId: this.agent.id,
        userId,
      });
      if (this.terminated || this.archived) throw new AgentEndedError(this.agent.handle);
      if (!(await this.d.store.restoreCancelled(messageId))) {
        if (this.queue.some((e) => e.kind === "message" && e.row.id === messageId)) return;
        throw new AlreadyDeliveredError();
      }
      const row = await this.d.store.pendingJoined(messageId);
      if (!row) throw new Error(`message ${messageId} is not pending after its restore`);
      this.seen.add(row.id);
      this.insertByCreated(entryOf(row));
      this.publishQueue();
      this.chatChanged([userId]);
      await this.wakeToDeliver("message", { attempts: true, inline: true });
      await this.flush();
    });
  }

  /**
   * Adds (or refreshes) a `@factory` notice. Call inside a job. A new notice goes ahead of every non-notice entry
   * (older pending messages, rolled-back batches); a replaced pending one only changes its body. Starts nothing.
   */
  async addNotice(type: NoticeType, body: string, subjectAgentId?: string) {
    const row = await this.d.store.createNotice(
      {
        toAgentId: this.agent.id,
        notice: type,
        body,
        ...(subjectAgentId ? { subjectAgentId } : {}),
      },
      { inFlightIds: this.inFlight.flat().map((e) => e.row.id) },
    );
    this.placeNotice(row);
    this.publishQueue();
  }

  /** A notice row into the queue: its entry refreshed when queued, else ahead of every non-notice entry. */
  private placeNotice(row: MessageRow) {
    const existing = this.queue.find(
      (e): e is MessageEntry => e.kind === "message" && e.row.id === row.id,
    );
    if (existing) existing.row = row;
    else {
      const at = this.queue.findIndex((e) => !isNotice(e));
      this.seen.add(row.id);
      this.queue.splice(at === -1 ? this.queue.length : at, 0, {
        kind: "message",
        row,
        from: "@factory",
        fromKind: "factory",
      });
    }
  }

  /**
   * I2 §7.3: records config change lines in the one pending `config_changed` notice (merged, sorted). Passive: it wakes
   * nothing and is held from the running process (see `flush`), so only the next process reads it. Never throws for a
   * terminated agent: its rows are rejected anyway.
   */
  recordConfigNotice(lines: string[]): Promise<void> {
    return this.run(async () => {
      if (this.terminationCommitted || !lines.length) return;
      await this.addNotice("config_changed", notices.configChanged(lines));
    });
  }

  /**
   * I7 §8.2: records an agent actor's change to one of this agent's reports in the one pending
   * `report_config_changed` notice for that report (merged, sorted). Passive like `recordConfigNotice`. Never throws
   * for a terminated agent.
   */
  recordReportNotice(reportId: string, by: string, lines: string[]): Promise<void> {
    return this.run(async () => {
      if (this.terminationCommitted || !lines.length) return;
      const report = await this.d.store.agentById(reportId);
      if (!report) return;
      await this.addNotice(
        "report_config_changed",
        notices.reportConfigChanged({
          by,
          report: await this.d.store.principalMention(reportId),
          lines,
        }),
        reportId,
      );
    });
  }

  /**
   * I2 §7.3: the `config_changed` event, appended as a job so it is published in seq order with this runtime's other
   * events (an open Session shows it live). `changes` are `describeChanges` lines only: never a config value.
   */
  appendConfigChanged(by: string, changes: string[]): Promise<void> {
    return this.run(async () => {
      await this.append(null, { type: "config_changed", by, changes });
    });
  }

  /**
   * I2 §7.3: a `config_changed` row written through the store while this runtime was loading (its init may have read
   * the queue before that write committed). Re-read: queued, its entry is refreshed; unseen and still pending, queued.
   */
  adoptNotice(id: string): Promise<void> {
    return this.run(async () => {
      if (this.terminationCommitted) return;
      const queued = this.queue.some((e) => e.kind === "message" && e.row.id === id);
      if (this.seen.has(id) && !queued) return; // written (or rejected) meanwhile
      const row = await this.d.store.pendingJoined(id);
      if (!row) return;
      this.placeNotice(entryOf(row).row);
      this.publishQueue();
    });
  }

  /** `addNotice` as its own job, then a flush (never starts a process). */
  postNotice(type: NoticeType, body: string): Promise<void> {
    return this.apiJob(async () => {
      await this.addNotice(type, body);
      await this.flush();
    });
  }

  /** I1 §7: one command queued for itself per agent: queued, or written with its turn still running. */
  private selfCommandPending(): boolean {
    return (
      this.queue.some((e) => (e.kind === "raw" || e.kind === "compact") && e.self) ||
      Boolean(this.selfCompact) ||
      (this.rawInFlight && this.rawSelf)
    );
  }

  /** `focus` is neutralised here (§5.1.3), so every caller is covered. */
  async compact(c: {
    focus?: string;
    /** The requester's mention, `<@ref>`. */
    by: string;
    userId?: string;
    clientMessageId?: string;
    self?: boolean;
  }): Promise<QueueItem> {
    const entry: CompactEntry = {
      kind: "compact",
      id: randomUUID(),
      by: c.by,
      createdAt: new Date(),
      ...(c.userId ? { userId: c.userId } : {}),
      ...(c.self ? { self: true } : {}),
      ...(c.focus ? { focus: neutraliseEnvelopeTags(c.focus) } : {}),
      ...(c.clientMessageId ? { clientMessageId: c.clientMessageId } : {}),
    };
    return this.apiJob(async () => {
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(this.agent.handle);
      if (c.self && this.selfCommandPending()) throw new SelfCommandPendingError();
      // A retry (a lost 202) returns the earlier dispatch and queues nothing, as for raw input.
      const retryKey =
        c.userId && c.clientMessageId ? `${c.userId}\0${c.clientMessageId}` : undefined;
      const dup = retryKey ? this.rawRetries.get(retryKey) : undefined;
      if (dup) return this.itemOf(dup);
      this.queue.push(entry);
      if (retryKey) this.rememberRetry(retryKey, entry);
      this.publishQueue();
      await this.wakeInline("compact");
      await this.flush();
      this.publishStatus(); // a compaction written now shows at once (U3 §6.1)
      return this.itemOf(entry);
    });
  }

  private rememberRetry(key: string, entry: RawEntry | CompactEntry): void {
    this.rawRetries.set(key, entry);
    if (this.rawRetries.size > RAW_RETRIES_KEPT) {
      const [oldest] = this.rawRetries.keys();
      if (oldest !== undefined) this.rawRetries.delete(oldest);
    }
  }

  /**
   * I1 §5.1: raw session input. The caller has classified and neutralised `text`. Held until no turn is open, written
   * as one user line with no envelope, and a barrier until its turn ends. A retry with the same sender and
   * `clientMessageId` returns the queued item.
   */
  async rawInput(c: {
    text: string;
    by: string;
    userId?: string;
    clientMessageId?: string;
    self?: boolean;
  }): Promise<QueueItem> {
    const entry: RawEntry = {
      kind: "raw",
      id: randomUUID(),
      text: c.text,
      by: c.by,
      createdAt: new Date(),
      ...(c.userId ? { userId: c.userId } : {}),
      ...(c.self ? { self: true } : {}),
      ...(c.clientMessageId ? { clientMessageId: c.clientMessageId } : {}),
    };
    return this.apiJob(async () => {
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(this.agent.handle);
      if (c.self && this.selfCommandPending()) throw new SelfCommandPendingError();
      // A retry (a lost 202) returns the earlier dispatch, queued, written or cancelled, and writes nothing.
      const retryKey =
        c.userId && c.clientMessageId ? `${c.userId}\0${c.clientMessageId}` : undefined;
      const dup = retryKey ? this.rawRetries.get(retryKey) : undefined;
      if (dup) return this.itemOf(dup);
      if (this.proc && !this.proc.raw) throw new CommandsUnsupportedError();
      this.queue.push(entry);
      if (retryKey) this.rememberRetry(retryKey, entry);
      this.publishQueue();
      await this.wakeInline("raw");
      // A process started just now that can't write raw input: take it back rather than drop it later.
      if (this.proc && !this.proc.raw) {
        this.queue = this.queue.filter((e) => e !== entry);
        if (retryKey) this.rawRetries.delete(retryKey);
        this.publishQueue();
        throw new CommandsUnsupportedError();
      }
      await this.flush();
      this.publishStatus();
      return this.itemOf(entry);
    });
  }

  /**
   * Stop (U3 §6.3, D1): takes the same hold as an urgent send, so a message sent right after it waits for the
   * interrupted turn's result instead of being absorbed by the aborting turn. A hold already set (a Stop or an urgent
   * send under way) makes it a no-op; a compaction is never interrupted (409 `compacting`, D5).
   */
  async interrupt(c: { by: string }): Promise<void> {
    return this.apiJob(async () => {
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(this.agent.handle);
      if (this.compactInFlight) throw new CompactingError();
      if (this.hold) return;
      // U3 §13.3 (review M1): a written command whose turn never opened has nothing to interrupt, and its turn_end may
      // never come; Stop ends its barrier so the queue moves again.
      if (this.proc && this.rawInFlight && !this.openTurnId) {
        this.rawInFlight = false;
        await this.append(null, { type: "control", cmd: "interrupt", by: c.by });
        this.publishQueue();
        await this.flush();
        this.publishStatus();
        return;
      }
      if (!this.proc || !this.openTurnId) throw new NoOpenTurnError();
      try {
        await this.beginInterruptHold(c.by);
      } catch (err) {
        // The process is going away and its `exited` is not processed yet: there is nothing to interrupt (409).
        if (err instanceof ProcessNotRunningError) throw new NoOpenTurnError();
        throw err;
      }
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
        // Never a plain assignment (S7 §8 step 1): a provisional latch must survive a refresh during the termination.
        if (r.terminatedAt && !this.terminationCommitted) this.markTerminated({ committed: true });
        if (moved && !this.terminated) await this.onCredentialChanged();
      }
      this.publishStatus();
    });
  }

  /**
   * Stop crons (S9 §10.3): a human stops the agent's in-session crons by hibernating its process, with the passive
   * `crons_stopped` notice waiting for its next wake. Idle: stops now; busy (or errored with a process, attempting,
   * rate-limited): stops at the first moment the agent isn't busy, the warm window not waited for; an apply-restart's
   * hibernate already under way is taken over. Anything else already stopping is refused.
   */
  stopCrons(by: string): Promise<{ status: "stopped" | "pending" }> {
    return this.apiJob(async () => {
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(this.agent.handle);
      const proc = this.proc;
      if (!proc || this.crons.size === 0) throw new StopCronsError("no_crons", this.agent.handle);
      if (proc === this.deadProc || proc === this.failingProc) {
        throw new StopCronsError("stopping", this.agent.handle);
      }
      if (this.stopping) {
        const a = this.afterExit;
        if (a?.kind !== "hibernate" || a.reason !== "apply_changes")
          throw new StopCronsError("stopping", this.agent.handle);
        // Takes the apply-restart's hibernate over, as a shutdown does: its exit records the stop, adds no
        // `restart_crons` notice, and wakes only for non-passive items.
        a.reason = "crons_stopped";
        a.by = by;
        this.restartPending = false; // `pendingWake` stays: the exit honours it (I7 §9.5)
        await this.addStopNotice(by);
        this.publishStatus();
        return { status: "stopped" as const };
      }
      if (this.stopNowAllowed()) {
        await this.stopCronsNow(by);
        this.publishStatus();
        return { status: "stopped" as const };
      }
      this.stopCronsPending = { by };
      this.publishStatus();
      return { status: "pending" as const };
    });
  }

  /** Idle in the sense of the Stop crons table: nothing open, nothing owed, not errored, attempting or paused. */
  private stopNowAllowed(): boolean {
    return !this.busy() && !this.errored && !this.attempting && !this.credentialPaused();
  }

  private async addStopNotice(by: string) {
    await this.addNotice(
      "crons_stopped",
      notices.cronsStopped({ by, crons: this.cronsList().map((c) => c.humanSchedule) }),
    );
  }

  /** In a job: the notice (from the crons live now), then the stop. */
  private async stopCronsNow(by: string) {
    await this.addStopNotice(by);
    if (this.beginHibernate("crons_stopped") && this.afterExit?.kind === "hibernate")
      this.afterExit.by = by;
  }

  /** The pending stop's trigger (the same moments as an apply-restart's): re-checked in its own job. */
  private queueStopCronsCheck() {
    if (this.stopCheckQueued) return;
    this.stopCheckQueued = true;
    void this.run(async () => {
      this.stopCheckQueued = false;
      const p = this.stopCronsPending;
      if (!p || this.terminated) return;
      const proc = this.proc;
      if (!proc || proc === this.deadProc || proc === this.failingProc || this.stopping) return;
      if (this.crons.size === 0) return this.cronsMayHaveEnded();
      if (!this.stopNowAllowed()) return;
      this.stopCronsPending = undefined;
      await this.stopCronsNow(p.by);
      this.publishStatus();
    }).catch((err: unknown) =>
      this.d.log.error({ err, agent: this.agent.handle }, "stopping the crons failed"),
    );
  }

  /** The crons reached zero before a pending stop ran: it is cleared and a restart it held back goes ahead. */
  private cronsMayHaveEnded() {
    if (!this.stopCronsPending || this.crons.size > 0) return;
    this.stopCronsPending = undefined;
    this.maybeRestart();
    this.publishStatus();
  }

  /**
   * Applies config changes at the next safe moment: stop the process gracefully and resume the same session on
   * the next start, whose prepareStart reloads everything from the DB. A no-op when no process is running.
   * `changes` (I2 §7.3) are the lines the restart applies, shown as `restartChanges` until the process exits; callers
   * that restart for other reasons (credential, grants, manager) pass none. `wake` is I7's self-edit (§9.5): when a restart ends up pending the
   * agent is woken after it with `config_continue`, no human message needed; a `current` that finds no difference
   * leaves neither.
   * `current` (I2 §7.2, I5 §8.2) reads the agent's effective doc and Library now (a fresh row through the resolver); undefined when it can't
   * be read. It is called here, in the job, so the decision always compares what the process started with against the
   * latest committed config, never against a doc a caller computed from rows read earlier: a request issued from stale
   * reads can't cancel a restart a newer change needs. The restart happens only when `describeChanges(started,
   * current)` is non-empty, and those lines are what it applies: a start already on the latest config restarts nothing,
   * and two edits that cancel out restart nothing. An unreadable config (a broken template or overlay) leaves what is
   * pending as it is: the next start fails closed anyway.
   * The config lines are kept apart from other causes and replaced on every `current` request. When they become empty
   * and no other cause is pending, the pending restart is dropped.
   */
  async requestRestart(
    opts: {
      changes?: string[];
      wake?: boolean;
      current?: () => Promise<ConfigSnapshot | undefined>;
    } = {},
  ): Promise<void> {
    await this.run(async () => {
      const now = opts.current ? await opts.current() : undefined;
      // Not running (or already going away): the next start reads the new values anyway.
      if (
        this.proc &&
        this.proc !== this.deadProc &&
        this.proc !== this.failingProc &&
        !this.stopping &&
        !this.terminated
      ) {
        this.dropClearedRestart();
        if (opts.current && this.started) {
          if (!now) {
            this.publishStatus();
            return;
          }
          this.configChanges = describeChanges(this.started, now);
          if (!this.configChanges.length && !this.otherRestartCause) {
            this.restartPending = false;
            this.pendingWake = false;
            this.publishStatus();
            return;
          }
        } else {
          this.otherRestartCause = true;
          for (const c of opts.changes ?? []) this.pendingChanges.add(c);
        }
        this.restartPending = true;
        if (opts.wake) this.pendingWake = true;
        this.maybeRestart();
      }
      this.publishStatus();
    });
  }

  /** A cleared restart (stop, exit, takeover) leaves nothing of its causes behind. */
  private dropClearedRestart() {
    if (this.restartPending) return;
    this.pendingWake = false;
    this.otherRestartCause = false;
    this.configChanges = [];
    this.pendingChanges.clear();
  }

  /** In a job: a restart when idle for a cause other than a config diff (`requestRestart` without `current`, for jobs). */
  private markRestartPending(changes: string[]) {
    this.dropClearedRestart();
    this.otherRestartCause = true;
    for (const c of changes) this.pendingChanges.add(c);
    this.restartPending = true;
    this.maybeRestart();
  }

  /**
   * Restart now (I7 §9.2), for agents and humans: one check table, the first match deciding, run in an API job. The
   * errored rows (1, 5, 6) come before the starting and stopping rows (2-4) because a `stop_failed` agent keeps
   * `deadProc` set and `stopping` true. Never call a public runtime method in here: each is its own job, and jobs are
   * serial, so it would wait on itself. `by` is the requester's mention. `changes` are the caller's `describeChanges` lines, `null`
   * when its resolver failed. `runtimeAllowed` is only "the local runtime is disabled in this factory".
   */
  restartNow(r: {
    by: string;
    force: boolean;
    changes: string[] | null;
    runtimeAllowed: boolean;
  }): Promise<RestartOutcome> {
    return this.apiJob(async () => {
      const { by } = r;
      const handle = this.agent.handle;
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(handle);
      if (this.errored) {
        if (this.errorKind === "resume_unrecoverable")
          throw new RecoveryRefusedError(
            "resume_unrecoverable",
            `@${handle}'s session can't be resumed; a human must start a new session.`,
          );
        return this.restartErrored(by, r.runtimeAllowed);
      }
      const proc = this.proc;
      if (this.starting || this.attempting || (proc && !this.sessionStarted))
        throw new RecoveryRefusedError("starting", `@${handle} is starting; try again shortly.`);
      // `stopping` outlives the exit (a fresh start resets it), so it only counts while a process is left.
      if (proc && (this.stopping || proc === this.deadProc || proc === this.failingProc))
        throw new RecoveryRefusedError("stopping", `@${handle} is stopping; try again shortly.`);
      if (this.compactInFlight)
        throw new RecoveryRefusedError(
          "compacting",
          `@${handle} is compacting; try again when it finishes.`,
        );
      if (!proc) return { status: "not_running" as const };
      if (this.restartNowPending) {
        // A cut restart is already under way: the later caller's name and changes win; nothing more to start.
        this.restartNowPending = { by, changes: r.changes };
        return { status: "restarting" as const };
      }
      const lost = this.lostSnapshot();
      const hasLost = lost.tasks.length > 0 || lost.crons.length > 0;
      if (hasLost && !r.force) {
        const data = {
          tasks: lost.tasks.map((t) => t.description || t.taskId),
          crons: lost.crons.map((c) => c.humanSchedule),
        };
        throw new RecoveryRefusedError("lost_work", lostWorkMessage(handle, data), data);
      }
      const turnWork = Boolean(
        this.openTurnId || this.awaiting.length || this.rawInFlight || this.hold,
      );
      if (turnWork || hasLost) {
        // Rows 9 and 10 start a process again.
        if (!r.runtimeAllowed)
          throw new RecoveryRefusedError("runtime_disabled", LOCAL_RUNTIME_DISABLED);
        await this.beginCutRestart(by, r.changes);
        this.publishStatus();
        return { status: "restarting" as const };
      }
      if (this.owedNotifications > 0) {
        this.markRestartPending(r.changes ?? []);
        this.publishStatus();
        return {
          status: "restart_pending" as const,
          note: `@${handle} restarts in a moment, once a finished task's result is delivered.`,
        };
      }
      // Row 12: an idle restart is a hibernate; the next start reads the latest config.
      if (!this.beginHibernate("apply_changes")) {
        // Refused (a batch still in flight): same as row 11, restart once it is delivered.
        this.markRestartPending(r.changes ?? []);
        this.publishStatus();
        return {
          status: "restart_pending" as const,
          note: `@${handle} restarts in a moment, once its current messages are delivered.`,
        };
      }
      if (r.changes?.length)
        await this.addNotice("config_changed", notices.configChanged(r.changes));
      this.publishStatus();
      return { status: "restarted_idle" as const };
    });
  }

  /**
   * Rows 9 and 10 (spec §9.2.1 steps 1 to 3), inside the job: hold every write, then interrupt the open turn, wait for
   * the turn an `awaiting` batch is still to start, or stop at once (no turn work, or a raw command whose turn may
   * never come). The stop itself is `beginRestartNowStop`, from the first release point.
   */
  private async beginCutRestart(by: string, changes: string[] | null) {
    this.restartNowPending = { by, changes };
    this.armRestartNowFallback();
    try {
      await this.cutRestartSteps(by);
    } catch (err) {
      // Never leave the write hold set: nothing would release it.
      this.clearRestartNow();
      if (this.attempting && this.attemptReason === "restart" && !this.stopping) {
        this.attempting = false; // `markAttempting` ran but no stop began, so no exit will clear it
        this.attemptReason = undefined;
        await this.d.store.setAttempting(this.agent.id, false).catch(() => undefined);
        this.publishStatus();
      }
      throw err;
    }
  }

  private async cutRestartSteps(by: string) {
    if (this.openTurnId) {
      if (this.hold) return; // a Stop's or an urgent send's hold is reused, not replaced
      try {
        await this.beginInterruptHold(by);
      } catch (err) {
        if (!(err instanceof ProcessNotRunningError)) throw err;
        // The process is going away and its `exited` isn't processed yet.
        throw new RecoveryRefusedError(
          "stopping",
          `@${this.agent.handle} is stopping; try again shortly.`,
        );
      }
      return;
    }
    if (this.awaiting.length) return; // `turn_started` interrupts, or the fallback stops
    await this.beginRestartNowStop();
  }

  /** The bound on a cut restart: if no release point fired within `holdTimeoutMs`, stop anyway (spec §9.2.1 step 2). */
  private armRestartNowFallback() {
    if (this.restartNowFallback) clearTimeout(this.restartNowFallback);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void this.run(async () => {
        if (this.restartNowFallback !== timer) return;
        this.restartNowFallback = undefined;
        if (!this.restartNowPending) return;
        try {
          await this.beginRestartNowStop();
        } catch (err) {
          if (this.proc) await this.onJobFailure(this.proc, err);
          else this.d.log.error({ err, agent: this.agent.handle }, "cut restart fallback failed");
        }
        this.publishStatus();
      }).catch((err) =>
        this.d.log.error({ err, agent: this.agent.handle }, "cut restart fallback job failed"),
      );
    }, this.d.holdTimeoutMs ?? 10_000);
    this.restartNowFallback = timer;
  }

  private clearRestartNow() {
    this.restartNowPending = undefined;
    if (this.restartNowFallback) clearTimeout(this.restartNowFallback);
    this.restartNowFallback = undefined;
  }

  /**
   * Spec §9.2.1 step 3, inside a job: the stop of a cut restart, from the first of `turn_end`, the interrupt hold's
   * timeout and the fallback. Does nothing when a stop is already under way (an archive or shutdown that began
   * meanwhile wins). The exit makes the attempt and its wake (`markAttempting`).
   */
  private async beginRestartNowStop(): Promise<void> {
    const pending = this.restartNowPending;
    const proc = this.proc;
    if (
      !pending ||
      !proc ||
      this.terminated ||
      this.stopping ||
      proc === this.deadProc ||
      proc === this.failingProc
    ) {
      // Known gap (PR 3 review, minor 3): when only a provisional `terminated` latch is the reason and the
      // termination then fails (`unmarkTerminated`), the restart the caller was told about is dropped. Rare
      // (spawned agents, failed TTL or terminate), so accepted.
      if (!this.stopping) this.clearRestartNow();
      return;
    }
    if (this.restartNowFallback) clearTimeout(this.restartNowFallback);
    this.restartNowFallback = undefined;
    await this.markAttempting("restart");
    const lost = this.lostSnapshot(); // fresh: tasks started during the interrupt window are killed too (T4)
    await this.append(null, { type: "control", cmd: "restart", by: pending.by });
    // A batch written with no turn open whose turn never started was marked delivered by its write and would be
    // dropped by the exit: back to pending and the head of the queue, since a duplicate beats a lost message.
    if (!this.openTurnId && this.awaiting.length) {
      const batches = this.awaiting;
      this.awaiting = [];
      await this.d.store.markPending(batches.flatMap((b) => b.ids));
      this.queue.unshift(...batches.flatMap((b) => b.entries));
    }
    await this.addNotice(
      "restart_applied",
      notices.restartApplied({
        by: pending.by,
        changes: pending.changes,
        tasks: lost.tasks.map((t) => t.description || t.taskId),
        crons: lost.crons.map((c) => c.humanSchedule),
      }),
    );
    this.beginForceStop({ kind: "restart", by: pending.by }, { graceMs: 3000, termWaitMs: 10_000 });
  }

  /**
   * Row 6, Restart of an errored agent (spec §9.7): the restart notice, `control{restart}`, then one attempt. A process
   * left is force-stopped and its exit makes the wake; a `stop_failed` agent gets one more escalation try first (§9.6).
   */
  private async restartErrored(by: string, runtimeAllowed: boolean) {
    this.refuseRecoveryWhileAttempting();
    if (!runtimeAllowed) throw new RecoveryRefusedError("runtime_disabled", LOCAL_RUNTIME_DISABLED);
    this.refuseWhileStopping();
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
    return { status: "restarting" as const };
  }

  /**
   * Start a new session (spec §9.7), only after a failed resume: clear the session id, `session_reset`, drop the
   * pending notices (they describe the old session), clear errored, and make pending human messages the new
   * session's first turn (one attempt). The old session's JSONL stays on disk.
   */
  resetSession(r: { by: string }): Promise<void> {
    return this.apiJob(async () => {
      this.refuseTerminated();
      if (this.archived) throw new AgentArchivedError(this.agent.handle);
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
      const { by } = r;
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
      // After the attempt began: a failed forward must not leave the pending human messages without one. The reset is
      // done, so the failure is logged rather than failing the human's call.
      await this.forwardRecovered().catch((err: unknown) =>
        this.d.log.error({ err, agent: this.agent.handle }, "forwarding recovered failed"),
      );
      this.publishStatus();
    });
  }

  /**
   * S7 §8 step 1, synchronous: nothing sends, wakes, starts, restarts, compacts or writes from here on. A provisional
   * latch (`committed: false`, set before the termination's transaction) keeps arriving rows queued rather than
   * rejected and doesn't show as terminated. The committed one drops what was queued (the transaction rejected it)
   * and ends any attempt (the transaction cleared `attempting`). No Supervisor call: `acceptsWake()` is now false,
   * and the Supervisor drops ineligible entries when it grants.
   */
  markTerminated(o: { committed: boolean }): void {
    if (!o.committed) {
      this.provisionalLatches += 1;
      this.restartPendingAtLatch ||= this.restartPending;
      this.pendingWakeAtLatch ||= this.pendingWake;
    }
    this.terminated = true;
    this.restartPending = false;
    this.pendingWake = false;
    if (o.committed && !this.terminationCommitted) {
      this.terminationCommitted = true;
      this.provisionalLatches = 0;
      this.restartPendingAtLatch = false;
      this.pendingWakeAtLatch = false;
      const dropped = [...this.queue, ...this.debounced].flatMap((e) =>
        e.kind === "message" ? [e.row.id] : [],
      );
      this.queue = [];
      this.debounced = [];
      this.attempting = false;
      this.attemptReason = undefined;
      this.attemptOwedAtExit = undefined;
      this.publishQueue();
      // A row committed after the transaction's reject-pending update but handed over during the provisional window
      // was only queued in memory: reject it in the DB too (spec §8, "Pending messages vs. rejection").
      if (dropped.length)
        void this.run(async () => {
          for (const id of dropped) this.chatChanged([await this.d.store.markRejected(id)]);
        }).catch((err: unknown) =>
          this.d.log.error({ err, agent: this.agent.handle }, "rejecting dropped rows failed"),
        );
    }
    this.clearOwedBound();
    this.updateWarmTimer();
    this.armDebounceTimer();
    this.publishStatus();
  }

  /**
   * S7 §8 step 2 on failure: the provisional latch is undone (a committed one never is), once no other termination is
   * still in flight. What arrived meanwhile is delivered normally: a running process flushes it, otherwise a
   * `queued_items` wake is requested; an apply-restart the latch cancelled and the owed-notification bound come back.
   * Not undone: an exit that happened during the window took the terminate path (the container removed, the
   * journal reaped, no wake); the next wake starts the agent again as usual.
   */
  unmarkTerminated(): void {
    if (this.terminationCommitted || !this.terminated) return;
    this.provisionalLatches = Math.max(0, this.provisionalLatches - 1);
    if (this.provisionalLatches > 0) return;
    this.terminated = false;
    const restart = this.restartPendingAtLatch;
    const wake = this.pendingWakeAtLatch;
    this.restartPendingAtLatch = false;
    this.pendingWakeAtLatch = false;
    this.armDebounceTimer();
    this.publishStatus();
    void this.run(async () => {
      if (this.terminated) return; // latched again meanwhile
      if (restart && this.proc && this.proc !== this.deadProc && !this.stopping) {
        this.restartPending = true;
        this.pendingWake = wake;
      }
      this.armOwedBound();
      if (this.proc) await this.flushOrStop("flush after a failed termination failed");
      else if (this.hasDeliverable()) await this.wakeFromJob("queued_items");
      this.maybeRestart();
      this.publishStatus();
    }).catch((err: unknown) =>
      this.d.log.error(
        { err, agent: this.agent.handle },
        "delivering after a failed termination failed",
      ),
    );
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * S7 §8 step 3, as a job: the `terminated` event (once), then a forced stop whose exit (step 4) removes the container
   * or reaps the journal and releases the slot. With no process, step 4 runs now. A process left by a failed stop
   * (`stop_failed`) gets one more escalation, as Restart does. Never awaited from inside another job.
   */
  terminateStop(by: string): Promise<void> {
    return this.run(async () => {
      await this.ensureTerminatedEvent(by);
      const proc = this.proc;
      if (proc && proc !== this.deadProc)
        this.beginForceStop({ kind: "terminate", by }, { graceMs: 0, termWaitMs: 3000 });
      else if (proc) {
        this.stopping = true;
        this.afterExit = { kind: "terminate", by };
        await this.escalateNow(proc, { removeOnFailure: true });
      } else await this.finishTerminationWithoutProcess();
      this.publishStatus();
    });
  }

  /** Inside a job (or at boot, before any job): appends `terminated{by}` unless the agent already has one. */
  async ensureTerminatedEvent(by: string): Promise<void> {
    if (await this.d.store.hasTerminatedEvent(this.agent.id)) return;
    await this.append(null, { type: "terminated", by });
  }

  /** S7 §8 step 4 with no process: the container removal or the journal reap, then the slot goes back. */
  private async finishTerminationWithoutProcess() {
    if (await this.terminationCleanup()) this.slots.release(this.agent.id);
  }

  /**
   * S7 §10.3 step 1, as a job (serialized with wakes and starts): whether the TTL may reap this agent now. Only with no
   * process (not starting, running or stopping), no queued or granted wake, no credential pause, not terminated, and
   * the row's `last_activity_at` still before `cutoff`. When all hold, the provisional latch is set here, inside the
   * job, so no wake can start a process between this check and the termination's transaction. The caller then runs
   * `TerminateService.terminate(…, { latched: true })` outside this agent's jobs.
   */
  reaperCheck(cutoff: number): Promise<boolean> {
    return this.run(async () => {
      if (!this.reapable()) return false;
      const row = await this.d.store.agentById(this.agent.id);
      if (
        row?.kind !== "ephemeral" ||
        row.terminatedAt ||
        row.archivedAt ||
        row.rateLimitNoticeOwed ||
        Math.max(row.lastActivityAt.getTime(), this.activityRecorded ?? 0) >= cutoff
      )
        return false;
      if (!this.reapable()) return false; // anything that changed while the row was read
      this.markTerminated({ committed: false });
      return true;
    });
  }

  private reapable(): boolean {
    return !(
      this.terminated ||
      this.archived ||
      this.noStart ||
      this.slots.closing() ||
      this.proc ||
      this.starting ||
      this.stopsInProgress > 0 ||
      this.slots.isQueued(this.agent.id) ||
      this.credentialPaused() ||
      // Rows waiting for delivery to an agent that would be woken for them (a message, a notice, a compact, or a
      // member update in its debounce, which wakes it once due): the termination would reject them, so wait for the
      // delivery. Passive items alone (peer events) never wake an agent and don't hold it; an errored agent's rows wait
      // for a human's Restart, and an errored agent is reaped (spec §10.3).
      ((this.queue.some((e) => !isPassive(e)) || this.debounced.length > 0) &&
        this.acceptsWake("queued_items"))
    );
  }

  /**
   * S7 §8 step 5 and §10.3 step 2, as a job: the sweep's pass over a terminated agent. First a missing `terminated`
   * event is appended (a crash after the commit). A stop still under way (a live process, a start, a `stop()`) is never
   * stuck: "still", nothing done. A process a failed stop left gets one more escalation (its exit cleans up). With no
   * process, a `stop_failed` agent, a journal that names processes, or (Docker) a container still listed for it gets
   * the cleanup again: the journal reap or the container removal; on success the slot goes back. "none": nothing was
   * left. `containerListed`: the sweep's Docker list shows a container labelled for this agent, so it is removed
   * whatever runtime the agent last ran (the row may have changed since).
   */
  sweepStuck(o: { containerListed?: boolean } = {}): Promise<"none" | "cleared" | "still"> {
    return this.run(async () => {
      const row = await this.d.store.agentById(this.agent.id);
      if (!row?.terminatedAt) return "none";
      if (!this.terminationCommitted) this.markTerminated({ committed: true });
      const by = await this.d.store.terminatorMentionOf(row.terminatedBy);
      await this.ensureTerminatedEvent(by);
      this.containerListed = Boolean(o.containerListed);
      const proc = this.proc;
      if (this.stopsInProgress > 0 || this.starting || (proc && proc !== this.deadProc))
        return "still";
      if (proc) {
        // The process a failed stop left (stop_failed): one more escalation, as terminateStop does.
        this.stopping = true;
        this.afterExit = { kind: "terminate", by };
        await this.escalateNow(proc, { removeOnFailure: true, sweep: true });
        this.publishStatus();
        return "still";
      }
      const j = row.runtimeJournal;
      const stuck =
        Boolean(o.containerListed) ||
        this.stopFailed() ||
        row.errorKind === "stop_failed" ||
        Boolean(j?.claude || j?.descendants?.length);
      if (!stuck && this.cleanupTarget().runtime !== "docker") return "none";
      // Docker: the removal finds a container still listed for it (running or stopped), or none.
      const r = await this.terminationCleanup({ container: o.containerListed });
      if (!r) return "still";
      this.containerListed = false; // removed (or none was left)
      if (!stuck && !r.done) return "none";
      this.slots.release(this.agent.id);
      this.publishStatus();
      return "cleared";
    });
  }

  /** S7 §10.2: the in-memory activity time, persisted as its own statement; a failure is only logged. */
  private persistActivity() {
    this.activityRecorded = Math.max(this.activityRecorded ?? 0, this.lastActivityAt);
    const at = new Date(this.lastActivityAt);
    void this.d.store
      .setLastActivity(this.agent.id, at)
      .catch((err: unknown) =>
        this.d.log.error({ err, agent: this.agent.handle }, "recording the last activity failed"),
      );
  }

  /**
   * S7 §8 step 4's cleanup: Docker removes the container (stop, then remove); local reaps whatever the journal names.
   * On success the journal is cleared. False when it failed: `stop_failed`, keeping the slot (S5 §9.6), logged; no
   * `errored` fact (forwarding is latched off). The sweep retries. `container`: a listed container is removed too, even
   * when the agent's last runtime was local.
   */
  private async terminationCleanup(
    o: { container?: boolean } = {},
  ): Promise<false | { done: CleanupResult | undefined }> {
    const target = this.cleanupTarget();
    let done: CleanupResult | undefined;
    try {
      if (target.runtime !== "docker") done = await this.d.cleanup?.(target);
      if (target.runtime === "docker" || o.container) {
        // Never counted as removed: the container may still run, so the sweep must retry (stop_failed keeps the slot).
        if (!this.d.docker) throw new Error("the Docker runtime isn't configured");
        const removed = await this.d.docker.containers.remove(this.agent.id, await this.ref());
        if (removed) done = { ...done, container: "removed" };
      }
    } catch (err) {
      this.d.log.error(
        { err, agent: this.agent.handle, runtime: target.runtime },
        `cleaning up a terminated agent failed${err instanceof Error ? `: ${err.message}` : ""}`,
      );
      await this.setErrored(stopFailedMessage(undefined), "stop_failed");
      return false;
    }
    this.journalProc = undefined;
    this.carriedPids = [];
    this.journalWork = { tasks: [], crons: [] };
    await this.d.store.setRuntimeJournal(this.agent.id, null);
    this.journalJson = "null";
    // An earlier failed stop is resolved now: nothing of the agent is left. `stop_failed` would keep it a stuck
    // candidate (§8 step 5) and its workspace undeletable forever.
    if (this.stopFailed()) {
      this.errored = false;
      this.lastError = undefined;
      this.errorKind = undefined;
      await this.d.store.clearErrored(this.agent.id);
    }
    if (done) await this.append(null, { type: "cleanup", ...done });
    return { done };
  }

  /** Synchronous: the archive route calls it before it stops the process, so no new send gets in. */
  markArchived(): void {
    this.archived = true;
    this.armDebounceTimer();
  }

  /** The closing latch (spec §5.6). Synchronous: a start already inside prepareStart re-checks it before the launch. */
  setNoStart(): void {
    this.noStart = true;
    this.updateWarmTimer();
    this.armDebounceTimer();
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
        this.d.log.error(
          { agent: this.agent.handle, reason },
          "grant for an agent that is running",
        );
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
      if (this.terminated) return;
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
    if (this.terminated || this.archived || this.noStart) return false;
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

  /**
   * A wake is only granted with something to write (spec §5.2): a pending message, notice, member update past its
   * debounce, or a queued compact. Updates still inside the debounce and passive items alone are not.
   */
  hasDeliverable(): boolean {
    return this.queue.some((e) => !isPassive(e));
  }

  /**
   * A turn is open or about to be: an open turn, a written batch awaiting its turn (`openTurnId` stays unset until
   * `turn_started`), an urgent hold, a compact in flight, or a stop under way.
   */
  private turnOpen(): boolean {
    return Boolean(
      this.openTurnId ||
        this.awaiting.length ||
        this.inFlight.length ||
        this.hold ||
        this.compactInFlight ||
        this.rawInFlight ||
        this.stopping,
    );
  }

  /**
   * S7 §8 step 5: a termination still stopping (a stop under way, a start, or a process whose stop hasn't failed) is
   * never stuck.
   */
  terminationSettling(): boolean {
    const proc = this.proc;
    return (
      this.stopsInProgress > 0 ||
      this.starting ||
      (Boolean(proc) && proc !== this.deadProc && !this.stopFailed())
    );
  }

  /** S7 §8 step 5: the sweep's last list showed a container still left for this terminated agent. */
  containerLeftListed(): boolean {
    return this.containerListed;
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
      if (!current() || this.terminated) return; // no continue notice for a terminated agent (S7 §12)
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
      else if (this.hasDeliverable()) await this.wakeFromJob("rate_limit_reset");
      this.publishStatus();
    });
  }

  /**
   * The Supervisor's pull of this agent's image failed (spec §11.2): its wake was dropped, so the start fails here,
   * with the registry's error verbatim. An attempt waiting on that wake ends with it.
   */
  imagePullFailed(message: string, fix?: StartFix): Promise<void> {
    return this.run(async () => {
      if (this.proc || this.starting || this.terminated) return; // started meanwhile, or terminated: nothing failed
      await this.append(null, { type: "error", source: "spawn", message, ...(fix ? { fix } : {}) });
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
    /** I2 §7.3: what the pending restart applies, sorted; empty when none is pending. */
    restartChanges: string[];
    waitingOn: WaitingOn;
    /** S9 §10.2: the live in-session crons, the zone their text is written in, and a pending Stop crons. */
    crons: LiveCronView[];
    cronZone: string;
    stopCronsPending: boolean;
    rateLimitedUntil?: string;
    rateLimitExact?: boolean;
    runtimeDisabled?: string;
    image?: { running: string | null; next: string };
    pulling?: boolean;
    turnStartedAt?: string;
    compacting?: boolean;
  } {
    const pause = this.slots.pauseOf(this.agent.id);
    return {
      status: this.status(),
      turnOpen: Boolean(this.openTurnId),
      ...(this.openTurnId && this.turnStartedAt ? { turnStartedAt: this.turnStartedAt } : {}),
      compacting: this.compactInFlight,
      ...(pause
        ? { rateLimitedUntil: pause.until.toISOString(), rateLimitExact: pause.exact }
        : {}),
      ...(this.lastError && this.errored ? { lastError: this.lastError } : {}),
      ...(this.errorKind && this.errored ? { errorKind: this.errorKind } : {}),
      ...(this.agent.runtime === "local" && !(this.d.localRuntimeAllowed?.() ?? true)
        ? { runtimeDisabled: LOCAL_RUNTIME_DISABLED }
        : {}),
      ...(this.agent.runtime === "docker" && (this.nextImage ?? this.runningImage)
        ? {
            image: {
              running: this.runningImage ?? null,
              next: (this.nextImage ?? this.runningImage) as string,
            },
          }
        : {}),
      ...(this.slots.isPulling(this.agent.id) ? { pulling: true } : {}),
      restartPending: this.restartPending,
      restartWaitingOn: this.restartPending ? this.nonAmbient() : 0,
      restartChanges: this.restartPending
        ? [...new Set([...this.pendingChanges, ...this.configChanges])].sort()
        : [],
      waitingOn: this.waitingOn(),
      crons: this.cronsList(),
      cronZone: cronZoneOf(this.agent.runtime),
      stopCronsPending: Boolean(this.stopCronsPending),
    };
  }

  /**
   * The live crons as the status lists them (S9 §10.2): `nextFireAt` only for one-shots (a recurring cron's is the first
   * firing, never updated), `expiresAt` only for recurring ones (Claude drops them after 7 days).
   */
  cronsList(): LiveCronView[] {
    return [...this.crons].map(([cronId, c]) => ({
      cronId,
      humanSchedule: c.humanSchedule,
      recurring: c.recurring,
      durable: c.durable,
      ...(c.recurring
        ? { expiresAt: new Date(c.createdAt + CRON_EXPIRY_MS).toISOString() }
        : { nextFireAt: new Date(c.nextFireAt).toISOString() }),
    }));
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
      (Boolean(this.proc) && !this.sessionStarted) ||
      Boolean(this.openTurnId) ||
      this.inFlight.length > 0 ||
      this.awaiting.length > 0 ||
      this.compactInFlight ||
      this.rawInFlight ||
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
   * deliverable queued unless the credential is paused (queued deliveries wait for the reset wake).
   */
  hibernatable(): boolean {
    const proc = this.proc;
    return (
      Boolean(proc) &&
      this.sessionStarted &&
      proc !== this.deadProc &&
      proc !== this.failingProc &&
      !this.stopping &&
      !this.noStart &&
      !this.terminated &&
      !this.busy() &&
      !this.pinned() &&
      !this.restartPending &&
      !this.errored &&
      !this.attempting &&
      (!this.hasDeliverable() || this.credentialPaused())
    );
  }

  statusFrame(): AgentStatusFrame {
    const l = this.live();
    return { type: "agent_status", agent: this.agentRef, ...l };
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
    this.pendingWake = false;
    this.publishStatus();
    try {
      const proc = await this.run(async () => {
        this.restartPending = false;
        this.pendingWake = false;
        // After the stop begins, so no write slips in between: `stopping` holds them from here.
        this.beginHibernate(this.archived ? "archived" : "shutdown", opts);
        this.clearRestartNow();
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
        this.armDebounceTimer(); // and the member updates' due time (I9 §4.8)
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
            err instanceof AgentTerminatedError ||
            err instanceof NoOpenTurnError ||
            err instanceof CompactingError ||
            err instanceof CommandsUnsupportedError ||
            err instanceof SelfCommandPendingError ||
            err instanceof RecoveryRefusedError ||
            err instanceof NotSenderError ||
            err instanceof AlreadyDeliveredError ||
            err instanceof AgentEndedError
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
      terminated: this.terminated && this.terminationCommitted, // a provisional latch doesn't show (S7 §8 step 1)
      errored: this.errored,
      attempting: this.attempting,
      working:
        this.starting ||
        (Boolean(this.proc) && !this.sessionStarted) ||
        Boolean(this.openTurnId) ||
        this.awaiting.length > 0 ||
        this.compactInFlight ||
        this.rawInFlight,
      credentialPaused: this.credentialPaused(),
      hasPendingWork: this.hasDeliverable(),
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
          kind: e.row.kind === "system" || isPeer(e) ? "notice" : "message",
          body: e.row.body,
          urgent: e.row.urgent,
          from: e.fromMention ?? e.from,
          fromKind: e.fromKind,
          createdAt: e.row.createdAt.toISOString(),
          ...taskFieldsOf(e.row),
          ...queueScheduleOf(e.row),
          ...(e.row.clientMessageId ? { clientMessageId: e.row.clientMessageId } : {}),
          // U3 §6.3: a Stop (or urgent send) is waiting for the interrupted turn's result.
          ...(this.hold ? { waitReason: "stopping" as const } : {}),
        }
      : e.kind === "raw"
        ? {
            id: e.id,
            kind: "raw",
            body: e.text,
            from: e.by,
            fromKind: e.userId ? "human" : "agent",
            createdAt: e.createdAt.toISOString(),
            ...(e.clientMessageId ? { clientMessageId: e.clientMessageId } : {}),
            ...(this.proc && this.turnOpen() ? { waitReason: "turn" as const } : {}),
          }
        : {
            id: e.id,
            kind: "compact",
            from: e.by,
            fromKind: e.userId ? "human" : "agent",
            createdAt: e.createdAt.toISOString(),
            ...(e.focus ? { focus: e.focus } : {}),
            ...(e.clientMessageId ? { clientMessageId: e.clientMessageId } : {}),
          };
  }

  /** `afterPublish` runs in the same tick as the `session_event` publish (U3 §11.2: a live reset right after its row). */
  private async append(
    turnId: string | null | undefined,
    event: AnyEvent,
    tx?: Tx,
    afterPublish?: () => void,
  ) {
    const dto = await this.d.store.append(this.agent.id, turnId ?? null, event, tx);
    if (!tx) {
      this.retireLive(event);
      this.d.bus.publish(this.agent.id, {
        type: "session_event",
        agent: this.agentRef,
        event: dto,
      });
      this.endSubagentLive(event);
      afterPublish?.();
    }
    await this.forwardEvent(event);
    return dto;
  }

  /**
   * S6 §9.1, by event type, once the event is stored: the report's top-level text as itself, API errors and refusals
   * as `turn_failed`, denials as `denied`. Subagent text, tool calls, blank text and everything else stay here.
   */
  private async forwardEvent(e: AnyEvent) {
    // A top-level tool boundary: Claude has now read every request written into the turn so far.
    if (e.type === "tool_result" && !e.parentToolUseId)
      this.turnRequestsSeen = this.turnRequests.length;
    if (this.terminated) return; // S7 §8: nothing about a terminated agent is forwarded
    if (e.type === "assistant_text") {
      if (e.parentToolUseId || !e.text.trim()) return;
      const seen = this.turnRequests.slice(0, this.turnRequestsSeen);
      const re = seen.length ? { re: seen } : {};
      await this.d.forward({ agentId: this.agent.id, body: capText(e.text), ...re });
    } else if (e.type === "error" && (e.source === "api" || e.source === "refusal"))
      await this.forwardFact("turn_failed", { text: e.message });
    else if (e.type === "permission_denied")
      await this.forwardFact("denied", { tool: e.toolName, text: e.reason });
  }

  private async forwardFact(fact: FactCode, detail?: FactDetail) {
    if (this.terminated) return; // S7 §8: the peer event (or the spawner's tool result) already said it
    await this.d.forward({
      agentId: this.agent.id,
      fact,
      body: factFor(fact, await this.d.store.principalMention(this.agent.id), detail),
    });
  }

  /** Errored with no attempt pending (S6 §9.1): forwarded once per errored episode. */
  private async forwardErrored() {
    if (this.erroredForwarded || this.terminated) return;
    // Set before the write so a re-entrant failure path (onJobFailure → setErrored) doesn't report it again; a failed
    // insert reported nothing, so the flag is cleared and a later errored path can retry.
    this.erroredForwarded = true;
    try {
      await this.forwardFact("errored", this.lastError ? { text: this.lastError } : {});
    } catch (err) {
      this.erroredForwarded = false;
      throw err;
    }
  }

  /** The error cleared (an attempt succeeded, or Start a new session): the episode ends. */
  private async forwardRecovered() {
    if (this.terminated) return;
    this.erroredForwarded = false;
    await this.forwardFact("recovered");
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
    this.d.bus.publish(this.agent.id, {
      type: "queue",
      agent: this.agentRef,
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
    // Every caller (start, resume, resume_unrecoverable, stop_failed, internal) leaves no attempt pending (S6 §9.1).
    await this.forwardErrored();
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
    this.attemptOwedAtExit = undefined;
    await this.d.store.setAttempting(this.agent.id, true);
    this.publishStatus();
  }

  /** Spec §9.2: no Restart or Start a new session in the middle of an attempt. */
  private refuseRecoveryWhileAttempting() {
    if (this.attempting)
      throw new RecoveryRefusedError(
        "attempt_in_progress",
        `@${this.agent.handle} is already being recovered. Wait for that attempt to finish.`,
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
      this.d.log.error({ err, agent: this.agent.handle }, "cleanup on restart failed");
      // Docker's last resort (spec §9.6): the container stop failed again, so remove the container.
      done = (await this.removeContainer()) ? { container: "removed" } : undefined;
      if (!done) {
        await this.setErrored(stopFailedMessage(undefined), "stop_failed");
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
    // S6 §9.1: an errored agent whose attempt never started is errored with no attempt pending (a crash's recovery
    // dropped or refused). Inside an episode already reported (a human retry) this is a no-op.
    if (this.errored) await this.forwardErrored();
  }

  /** Spec §9.2: the attempt's batch turn ended with the process running. Clears the attempt and the error. */
  private async attemptSucceeded() {
    const wasErrored = this.errored; // a boot_resume attempt may run on an agent that never errored
    this.attempting = false;
    this.attemptReason = undefined;
    this.errored = false;
    this.lastError = undefined;
    this.errorKind = undefined;
    await this.d.store.clearErrored(this.agent.id);
    if (wasErrored) await this.forwardRecovered();
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
      if (
        !(
          err instanceof AgentStartError ||
          err instanceof AgentArchivedError ||
          err instanceof AgentTerminatedError
        )
      ) {
        if (this.proc) await this.onJobFailure(this.proc, err);
        else this.d.log.error({ err, agent: this.agent.handle }, what);
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
    } finally {
      this.starting = false;
      // A container that couldn't be stopped keeps the slot (stop_failed, spec §9.6).
      if (!launched && !this.keepSlotAfterFailedStart) this.slots.release(this.agent.id);
    }
    // A pause that landed after the grant (spec §5.2): back to the queue (a granted entry keeps its place).
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
    this.refuseBeforeLaunch();
    // One token per launch (spec §5.2), revoked when its process exits; a start that never gets a process revokes it
    // here, whatever the failure and whether or not the slot is kept. The plaintext goes only to prepareStart.
    const { token, generation } = this.d.tokens.mint(this.agent.id);
    let assigned = false;
    try {
      return await this.launchWith(reason, token, generation, () => {
        assigned = true;
        onLaunched();
      });
    } finally {
      if (!assigned) this.d.tokens.revoke(this.agent.id, generation);
    }
  }

  private async launchWith(
    reason: WakeReason,
    agentToken: string,
    generation: number,
    onLaunched: () => void,
  ): Promise<boolean> {
    // prepareStart takes the agent's ref lock (KeyedMutex is not re-entrant). The runtime never holds that
    // lock: it has no handle to it, and its own serialization is the job queue.
    // I2 §7.3: stamped before the prepare reads the config, so a change landing during the prepare is held for the next
    // process (the start may have read the config before it).
    const procStartedAt = this.d.store.clock();
    let prepared: PreparedSpec;
    try {
      prepared = await this.d.prepareStart(this.agent, { agentToken });
    } catch (err) {
      if (err instanceof AgentArchivedError) {
        this.archived = true;
        throw err;
      }
      // Terminated during prepare: not a start failure to record (and nothing to forward).
      if (this.terminated) throw new AgentStartError(TERMINATED_START);
      return this.failStart(err, "prepareStart failed");
    }
    // `effective` holds env values: it is kept out of the spec the driver sees, and kept as `started` at the launch.
    const { launch: dockerLaunch, credentialId, effective, ...prepSpec } = prepared;
    // I2 §6.2: the Supervisor checked (and pulled) `nextImage` before the grant. A start that resolved another image (a
    // disk edit no scan has seen yet) updates it and goes back through the pull, as an image found missing does.
    if (dockerLaunch && dockerLaunch.image !== this.nextImage) {
      this.nextImage = dockerLaunch.image;
      return false;
    }
    let spec: AgentRuntimeSpec = prepSpec;
    // Docker (spec §10 step 4): the container, outside the workspace lock; any throw from here to the launch stops it.
    let container: (EnsureResult & { image: string }) | undefined;
    if (spec.runtime === "docker") {
      container = await this.ensureContainer(spec, dockerLaunch);
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
    this.tokenGens.set(proc, generation);
    onLaunched();
    this.proc = proc;
    this.started = effective;
    this.runningImage = container?.image;
    this.procStartedAt = procStartedAt;
    // This process runs on the config the changes describe.
    this.pendingChanges.clear();
    this.configChanges = [];
    this.otherRestartCause = false;
    this.procCredentialId = credentialId; // what prepareStart launched on, not the row (a spawned agent's differs)
    this.procRuntime = spec.runtime;
    this.sessionStarted = false;
    this.stopping = false; // only reached with no stop() in progress: this is a fresh start after it completed
    this.afterExit = undefined;
    this.liveTasks = new Map();
    this.crons = new Map();
    this.owedNotifications = 0;
    this.clearOwedBound();
    this.lastActivityAt = Date.now();
    // Pump first: its jobs queue behind this one, and if the append below fails the stop's `exited` is still consumed.
    this.liveState.newProcess();
    this.taskToolUse = new Map();
    void this.pump(proc);
    void this.storeCommands(proc);
    void this.drainLive(proc); // every process, restarts and resumes included: the queue is unbounded
    if (container) {
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
    this.persistActivity(); // after the event committed (S7 §10.2)
    this.journalProc = undefined; // a new process: its own journaled tree starts empty
    await this.snapshotJournal(proc);
    this.publishStatus();
    return true;
  }

  /** U3 §13.3: the process's command list, stored once `initialize` answers. Never in the event log. */
  private async storeCommands(proc: HarnessProcess) {
    try {
      const list = await proc.commands?.();
      if (!list) return;
      const { dropped } = await this.d.store.saveCommands(
        this.agent.id,
        list,
        proc.claudeCodeVersion ?? null,
      );
      if (dropped)
        this.d.log.warn({ agent: this.agent.handle, dropped }, "dropped malformed command entries");
      this.d.bus.publish(this.agent.id, {
        type: "agent_commands_changed",
        agent: this.agentRef,
      });
    } catch (err) {
      this.d.log.warn({ err, agent: this.agent.handle }, "storing the command list failed");
    }
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
      this.d.log.error({ err, agent: this.agent.handle }, "reaping the previous process failed");
      // The slot and the cleanup target first: a failing DB write below must not free the slot of a running process.
      this.keepSlotAfterFailedStart = true;
      this.procRuntime = "local"; // Restart's cleanup reaps the journal again
      const message = previousProcessMessage(j?.claude?.pid);
      const logFailure = (e: unknown) =>
        this.d.log.error({ err: e, agent: this.agent.handle }, "recording stop_failed failed");
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
  private async recordStartFailure(raw: unknown, what: string): Promise<AgentStartError> {
    const err =
      raw instanceof AgentStartError && this.agent.kind === "ephemeral"
        ? forSpawnedAgent(raw)
        : raw;
    const known = err instanceof AgentStartError;
    const message = known ? err.message : "The agent couldn't be prepared to start.";
    if (!known) this.d.log.error({ err, agent: this.agent.handle }, what);
    await this.append(null, {
      type: "error",
      source: "spawn",
      message,
      ...(known && err.fix ? { fix: err.fix } : {}),
      ...(known && err.detail ? { detail: err.detail } : {}),
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
  ): Promise<EnsureResult & { image: string }> {
    // Invariants, outside the Docker error mapping: a programming error must not read as a Docker fault.
    const docker = this.dockerDeps();
    if (!launch) throw new Error("a Docker start was prepared without its launch");
    try {
      const r = await docker.containers.ensure({
        agentId: this.agent.id,
        ref: await this.ref(),
        image: launch.image,
        mounts: spec.mounts,
        mountCheck: launch.mountCheck,
      });
      return { ...r, image: launch.image };
    } catch (err) {
      // Removed after the pull check (spec §11.2): the start fails, and the image is forgotten so the next wake
      // checks and pulls it again.
      if (err instanceof ImageMissingError) docker.onImageMissing?.(err.image);
      // A mount refused by the re-check keeps its own message ("Mount <path> isn't allowed: <reason>.").
      const startErr =
        err instanceof WorkspaceError
          ? new AgentStartError(err.message, err.fix, err.diagnosis)
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
      await this.d.docker?.containers.stopIfRunning(this.agent.id, await this.ref());
      return true;
    } catch (err) {
      this.d.log.error(
        { err, agent: this.agent.handle },
        "stopping the container of a start that didn't launch failed",
      );
      // The slot and the cleanup target first: a failing DB write below must not free the slot of a running container.
      this.keepSlotAfterFailedStart = true;
      this.procRuntime = "docker"; // Restart's cleanup stops (or removes) this container, whatever ran last
      // setErrored sets the in-memory truth first; the DB may be what failed.
      await this.setErrored(stopFailedMessage(undefined), "stop_failed").catch((e) =>
        this.d.log.error({ err: e, agent: this.agent.handle }, "recording stop_failed failed"),
      );
      this.publishStatus();
      return false;
    }
  }

  /** Restart's last resort for Docker (spec §9.6): force-remove the container. False when it failed too. */
  private async removeContainer(): Promise<boolean> {
    if (this.cleanupTarget().runtime !== "docker" || !this.d.docker) return false;
    try {
      await this.d.docker.containers.forceRemove(this.agent.id, await this.ref());
      return true;
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.handle }, "removing the container failed");
      return false;
    }
  }

  /** The ref every frame names the agent by: read in `init()`; reading it earlier throws rather than yield an empty ref. */
  private agentRefValue: string | undefined;
  private get agentRef(): string {
    if (this.agentRefValue === undefined) throw new Error("the runtime was read before init()");
    return this.agentRefValue;
  }

  /** The ref its container is named by, read once from `principals` (it never changes). */
  private refOnce?: Promise<string>;
  private ref(): Promise<string> {
    this.refOnce ??= this.d.store.refOfAgent(this.agent.id);
    return this.refOnce;
  }

  /** The agent as the cleanup port sees it: with the runtime its last process ran under. */
  private cleanupTarget(): AgentRecord {
    return { ...this.agent, runtime: this.runningRuntime() };
  }

  /** The runtime of the last launched process (the row may have changed since), else the row's. */
  private runningRuntime(): "local" | "docker" {
    return this.procRuntime ?? this.agent.runtime;
  }

  /** Not recorded as a start failure: the agent isn't broken, it is being stopped (shutdown, archive). */
  private refuseWhileStopping() {
    if (this.stopsInProgress > 0 || this.noStart || this.slots.closing())
      throw new AgentStartError("The agent is being stopped.");
  }

  /** The last check before the launch: the stop latches, and an archive or termination that landed during prepare. */
  private refuseBeforeLaunch() {
    if (this.terminated) throw new AgentStartError(TERMINATED_START);
    if (this.archived) throw new AgentArchivedError(this.agent.handle);
    this.refuseWhileStopping();
  }

  /** S7 §8: REST compact, interrupt, restart and reset-session on a terminated agent (`409 agent_terminated`). */
  private refuseTerminated() {
    if (this.terminated) throw new AgentTerminatedError(this.agent.handle);
  }

  private async pump(proc: HarnessProcess) {
    try {
      await this.pumpEvents(proc);
    } finally {
      this.revokeToken(proc); // every exit path, even one whose `exited` event never arrived
    }
  }

  /**
   * U3 §11.2: the live loop, outside the serial job queue (no DB, no job), until the process's live queue ends. Events
   * of a process that is no longer current are drained and dropped.
   */
  private async drainLive(proc: HarnessProcess) {
    if (!proc.live) return;
    try {
      for await (const e of proc.live) if (proc === this.proc) this.applyLive(e);
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.handle }, "live event handling failed");
    }
  }

  private applyLive(e: LiveEvent) {
    try {
      this.liveState.apply(e);
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.handle }, "a live event could not be applied");
    }
  }

  private publishLive(body: LiveFrameBody) {
    this.d.bus.publish(this.agent.id, { type: "live", agent: this.agentRef, ...body });
  }

  /** The whole live state as a `reset` frame (U3 §11.3): sent after a subscribe's replay and on `live_snapshot`. */
  liveSnapshot(): LiveFrame {
    return { type: "live", agent: this.agentRef, ...this.liveState.snapshot() };
  }

  /** The stdout line of a persisted event (U3 §11.2); unknown (a driver without lines) clears everything. */
  private lineOf(proc: HarnessProcess, e: HarnessEvent): number {
    return proc.lineOf?.(e) ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Before a persisted row is published: its live block retires, so no frame published after the row holds it (U3
   * §11.2). A subscriber whose replay read the row just before this runs can still get it in its snapshot; the client
   * ignores a reset text for a key it already has a row for (§11.4).
   */
  private retireLive(e: AnyEvent) {
    if (e.type !== "assistant_text" && e.type !== "tool_call") return;
    if (e.parentToolUseId) return; // subagents never stream
    if (e.messageId !== undefined && e.blockIndex !== undefined)
      this.liveState.retire(liveKey(e.messageId, e.blockIndex));
    else if (e.type === "tool_call") this.liveState.retireTool(e.toolUseId);
  }

  /** After a persisted row is published: a finished subagent's live line goes (U3 §11.2, §12). */
  private endSubagentLive(e: AnyEvent) {
    if (e.type === "background_task_started" && e.toolUseId)
      this.taskToolUse.set(e.taskId, e.toolUseId);
    else if (e.type === "background_task_finished") {
      const toolUseId = this.taskToolUse.get(e.taskId);
      this.taskToolUse.delete(e.taskId);
      if (toolUseId) this.liveState.finishSubagent(toolUseId, { agent: true });
    } else if (e.type === "tool_result" && !e.parentToolUseId) {
      // An async (auto-backgrounded) call's result is the launch notice: it keeps running (§12).
      if (e.meta?.tool === "Agent" && e.meta.async) return;
      this.liveState.finishSubagent(e.toolUseId, { agent: e.meta?.tool === "Agent" });
    }
  }

  private revokeToken(proc: HarnessProcess) {
    const generation = this.tokenGens.get(proc);
    if (generation === undefined) return;
    this.tokenGens.delete(proc);
    this.d.tokens.revoke(this.agent.id, generation);
  }

  private async pumpEvents(proc: HarnessProcess) {
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
      { err, agent: this.agent.handle },
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
        this.sessionStarted = true;
        const row = await this.d.store.agentById(this.agent.id);
        if (!row?.sessionId) await this.d.store.setSessionId(this.agent.id, e.sessionId);
        else if (row.sessionId !== e.sessionId)
          this.d.log.error(
            { agent: this.agent.handle, stored: row.sessionId, got: e.sessionId },
            "session id changed",
          );
        // An errored agent's error clears only when its attempt succeeds (spec §9.2), not at session_started.
        await this.append(null, e);
        // `pending` is normal: init precedes the MCP connection. Only a missing entry or a failure is unavailable.
        if (e.mcpServers) {
          const factory = e.mcpServers.find((m) => m.name === "factory");
          if (!factory || (factory.status !== "connected" && factory.status !== "pending")) {
            const status = factory?.status ?? "missing";
            this.d.log.warn(
              { agent: this.agent.handle, status },
              "the factory MCP server isn't connected",
            );
            await this.append(null, { type: "mcp_unavailable", status });
          }
        }
        const flight = this.inFlight.splice(0);
        for (const batch of flight) await this.d.store.markDelivered(batch.map((m) => m.row.id));
        // A batch written before session_started was pending until now (I1 §6.5): its sender's chat changed.
        this.chatChanged(
          flight.flatMap((batch) =>
            batch.map((m) => (m.fromKind === "human" ? m.row.fromId : null)),
          ),
        );
        break;
      }
      case "turn_started":
        this.clearOwedBound(); // the bound only runs while no turn is open
        this.openTurnId = await this.d.store.openTurn(this.agent.id, this.procCredentialId ?? null);
        this.lastUsage = undefined;
        this.absorbed = [];
        this.turnRequests = [
          ...this.carriedRequests,
          ...requestsOf(this.awaiting.flatMap((b) => b.entries)),
        ];
        this.turnRequestsSeen = this.turnRequests.length;
        this.carriedRequests = [];
        this.turnStartedAt = (await this.append(this.openTurnId, e)).at;
        this.chatChanged(sendersOf(this.awaiting));
        // I7 §9.2.1 step 2: the turn of a batch written before the cut restart began has started now.
        if (this.restartNowPending && !this.hold && !this.stopping) {
          try {
            await this.beginInterruptHold(this.restartNowPending.by);
          } catch (err) {
            // The process is going away: its exit clears the cut restart.
            if (!(err instanceof ProcessNotRunningError)) throw err;
          }
        }
        break;
      case "usage":
        this.lastUsage = e;
        await this.append(this.openTurnId, e);
        break;
      case "turn_end": {
        const turnId = this.openTurnId;
        // I9 §4.8: whether this turn end settles the batches written before it began (see the close below).
        const settles = !e.originKind || e.numTurns !== 0;
        // U3 §11.2: right after the turn_end row, in the same tick (no live patch in between), so the client clears its
        // live state first and the reset restores a block a self-started turn already began.
        const closing = sendersOf([...this.awaiting, ...this.absorbed]);
        const endSeq = (
          await this.append(turnId, e, undefined, () =>
            this.liveState.endBefore(this.lineOf(proc, e), { subagents: false }),
          )
        ).seq;
        if (turnId) {
          const close = {
            isError: e.isError,
            terminalReason: e.terminalReason,
            originKind: e.originKind,
            usage: this.lastUsage,
          };
          // S10 §5.2 (F1): the turn stamps the batches written before it began before the close, in the close's
          // transaction, so `attributeTask` sees them. I9 §4.8: every turn end settles them, a self-started one's (cron,
          // `/loop`, task notification, subagent hand-back) too: Claude takes an idle-written batch into whatever turn it
          // starts next, and a batch left waiting for an origin-less turn end would hold the barrier forever (no
          // delivery, "working", never hibernating). The trade-off: a batch written just after a self-started turn's
          // last tool boundary runs as its own next turn, so its stamp lands on the self-started turn and its own turn
          // is unattributed. That needs a write racing that boundary and stays within the neighbouring turn. The one
          // self-started turn known to read nothing is left out: a zero-turn result (`numTurns: 0`, no model call, the
          // orphan report after a resume) can't have taken a batch in. A self-started turn is never attributed.
          await this.d.store.closeTurnWith(
            turnId,
            close,
            settles ? this.awaiting.flatMap((b) => b.ids) : [],
            !e.originKind,
            endSeq,
          );
          if (settles) this.awaiting = [];
        }
        this.absorbed = []; // the stamp and the close committed: the batch is no longer working
        this.carriedRequests = this.turnRequests.slice(this.turnRequestsSeen);
        this.turnRequests = [];
        this.turnRequestsSeen = 0;
        this.chatChanged(closing);
        // The attempt's batch turn (spec §9.2): the first origin-less turn_end after its batch was written.
        if (!e.originKind && this.attempting && this.attemptBatchWritten && this.sessionStarted)
          await this.attemptSucceeded();
        this.openTurnId = undefined;
        this.turnStartedAt = undefined;
        this.lastActivityAt = Date.now();
        this.persistActivity(); // the turn_end event and the turn row are written (S7 §10.2)
        await this.oweNoticeIfCutOff();
        if (e.command === "compact" || (this.compactFailedSeen && !e.originKind)) {
          this.compactInFlight = false;
          this.compactFailedSeen = false;
          // I1 §7: decided once, here: failed if a `compact_failed` came since the compact was written.
          const own = this.selfCompact;
          this.selfCompact = undefined;
          if (own) await this.addNotice("compact_continue", notices.compactContinue(own));
        }
        // U3 §13.3: the command's turn (the first origin-less one after the write) ends its barrier.
        if (!e.originKind) this.rawInFlight = false;
        if (e.originKind === "task-notification")
          this.owedNotifications = Math.max(0, this.owedNotifications - 1);
        this.armOwedBound();
        if (e.originKind === "cron") await this.dropFiredOneShots();
        this.releaseHold();
        if (this.restartNowPending) await this.beginRestartNowStop();
        else await this.flush();
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
      case "rate_limit_status":
        // Not a timeline event; a status write must never fail the turn.
        try {
          // The launch credential: the status is about the one the process runs on, even after an edit.
          if (this.procCredentialId)
            await this.d.store.recordRateLimit(this.procCredentialId, e, new Date());
        } catch (err) {
          this.d.log.error(
            { err, agent: this.agent.handle },
            "could not record the rate-limit status",
          );
        }
        break;
      case "compact_failed":
        if (e.trigger === "manual") {
          if (this.selfCompact) this.selfCompact.failed = true;
          if (this.compactInFlight) this.compactFailedSeen = true;
        }
        await this.append(this.openTurnId, e);
        break;
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
          durable: e.durable === true,
        });
        await this.append(this.openTurnId, e);
        await this.writeJournal();
        break;
      case "cron_deleted":
        this.crons.delete(e.cronId);
        await this.append(this.openTurnId, e);
        await this.writeJournal();
        this.cronsMayHaveEnded();
        break;
      case "error":
        await this.append(this.openTurnId, e);
        if (!this.sessionStarted && (e.source === "resume" || e.source === "spawn")) {
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
        try {
          await this.onExited(proc, e);
        } finally {
          // A crash restart inside onExited already started the next process, which cleared the live state.
          if (!this.proc || this.proc === proc) {
            this.taskToolUse = new Map();
            this.liveState.endBefore(this.lineOf(proc, e), { subagents: true });
          }
        }
        this.maybeRestart();
        break;
      default:
        await this.append(this.openTurnId, e);
    }
    this.publishStatus();
  }

  /**
   * I1 §6.3: an exit closes the open turn, stamping the written batch it started with (a message-started turn). A
   * written batch with no turn opened gets a zero-length errored turn, so the message still has an outcome.
   */
  private async closeExitedTurn(
    openTurnId: string | undefined,
    stampIds: string[],
    usage: Extract<HarnessEvent, { type: "usage" }> | undefined,
    credentialId: string | null,
    e: Extract<HarnessEvent, { type: "exited" }>,
  ): Promise<void> {
    const close = {
      isError: !e.expected,
      terminalReason: e.expected ? "process_stopped" : "process_exited",
    };
    if (openTurnId)
      return this.d.store.closeTurnWith(openTurnId, { ...close, usage }, stampIds, true);
    if (!stampIds.length) return;
    const turnId = await this.d.store.openTurn(this.agent.id, credentialId);
    await this.d.store.closeTurnWith(turnId, close, stampIds, true);
  }

  private async onExited(proc: HarnessProcess, e: Extract<HarnessEvent, { type: "exited" }>) {
    this.revokeToken(proc);
    // S7 §8 step 4: the exit path is chosen by the latch, not by the recorded intent (markStopFailed overwrites it with
    // `internal`, and a crash exit may arrive before the stop job recorded one). A forced stop that never wakes.
    const terminating = this.terminated;
    const intent = this.afterExit;
    this.afterExit = undefined;
    this.restartPending = false;
    this.clearRestartNow();
    const wake = this.pendingWake; // honoured by a hibernate exit below; every other exit drops it
    this.pendingWake = false;
    this.pendingChanges.clear();
    this.configChanges = [];
    this.otherRestartCause = false;
    this.stopCronsPending = undefined; // the crons die with the process anyway (S9 §10.3)
    const attemptOwed = this.attemptOwedAtExit; // only this process's exit honours it
    this.attemptOwedAtExit = undefined;
    if (this.escalationTimer) clearTimeout(this.escalationTimer);
    this.escalationTimer = undefined;
    // Spec §9.1: no recorded intent and not expected, whether or not the agent is errored or attempting.
    const crash = !terminating && !intent && !e.expected;
    // Leftovers are cleaned up after a crash, an escalation, a Restart's force stop and a termination (spec §9.2, §9.6,
    // §9.7, §12; S7 §8).
    const forced = crash || intent?.kind === "restart" || this.escalated.has(proc) || terminating;
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
    // Unconfirmed batches re-enter the head in their original order (spec §8.3 rule 7). A terminated agent's are
    // rejected below instead (S7 §8 step 4).
    if (!terminating) this.queue.unshift(...rolledBack.flat());
    // Notices go ahead of rolled-back batches (spec §9.5); a stable partition keeps each group in order.
    this.queue = [...this.queue.filter(isNotice), ...this.queue.filter((e) => !isNotice(e))];
    this.openTurnId = undefined;
    this.turnStartedAt = undefined;
    this.releaseHold();
    this.compactInFlight = false;
    this.compactFailedSeen = false;
    this.rawInFlight = false;
    this.selfCompact = undefined; // no notice: the restart's own notice covers it
    // A batch written after session_started whose turn hadn't begun: delivered but never answered (lost work).
    const batchUnanswered = this.awaiting.length > 0;
    // Stamped by the close below (I1 §6.3). A batch written before session_started is still in `rolledBack`: it was
    // never delivered, goes back to pending (or is rejected) and gets no stamp or turn of its own.
    const rolledIds = new Set(rolledBack.flat().map((m) => m.row.id));
    const unansweredIds = this.awaiting.flatMap((b) => b.ids).filter((id) => !rolledIds.has(id));
    const closingBatches = [...this.awaiting, ...this.absorbed];
    const credentialId = this.procCredentialId ?? null; // cleared below, the close still records it
    this.awaiting = [];
    this.absorbed = [];
    // The process is gone: unconfirmed rows are redelivered as pending, so nothing carries over.
    this.turnRequests = [];
    this.turnRequestsSeen = 0;
    this.carriedRequests = [];
    if (this.proc === proc) {
      this.proc = undefined;
      this.procCredentialId = undefined;
      this.started = undefined;
      this.runningImage = undefined;
      this.procStartedAt = undefined;
    }
    this.sessionStarted = false;
    const live = { turnOpen: Boolean(openTurnId), batchUnanswered, lost };
    const policy = crash ? this.onCrash(e, live) : "none";
    let keepSlot = false;
    this.closing = closingBatches;
    try {
      // S10 §11: close the turn before the cleanup, which can take seconds (a Docker stop). A status frame published
      // meanwhile already says turnOpen false, so the row must be closed by then. A failed close must not skip the
      // cleanup: it is rethrown where the close used to be.
      const closeFailure = await this.closeExitedTurn(
        openTurnId,
        unansweredIds,
        usage,
        credentialId,
        e,
      ).then(
        () => undefined,
        (err: unknown) => ({ err }),
      );
      this.closing = undefined; // the stamp and the close settled: the outcome is readable
      this.chatChanged(sendersOf(closingBatches));
      // Terminated: Docker removes the container rather than stopping it (S7 §8 step 4).
      if (terminating) keepSlot = !(await this.terminationCleanup());
      else if (reap || docker) keepSlot = !(await this.cleanUpLeftovers(crash, forced));
      else this.journalProc = undefined; // a clean exit: nothing of it is left to reap
      if (!terminating) await this.oweNoticeIfCutOff(); // the exit ended a turn the rate limit cut off
      for (const batch of rolledBack) {
        const ids = batch.map((m) => m.row.id);
        if (terminating)
          for (const id of ids) this.chatChanged([await this.d.store.markRejected(id)]);
        else await this.d.store.markPending(ids);
        await this.append(null, {
          type: "delivery_failed",
          messageIds: ids,
          reason: e.expected
            ? "stopped before the session started"
            : "the agent process exited before the session started",
        });
      }
      if (closeFailure) throw closeFailure.err;
      await this.append(null, e);
      if (terminating) await this.reportLostWork("terminated", lost);
      else if (intent?.kind === "hibernate") {
        await this.recordLostWork(intent, Boolean(openTurnId), wake);
        await this.append(null, {
          type: "hibernated",
          reason: intent.reason,
          ...(intent.reason === "crons_stopped" && intent.by ? { by: intent.by } : {}),
          ...(intent.reason === "warm_window"
            ? { idleMinutes: Math.round((Date.now() - this.lastActivityAt) / 60_000) }
            : {}),
        });
      }
      if (intent?.kind === "restart" && !terminating) await this.reportLostWork("restart", lost);
      if (policy !== "none" && policy !== "hibernated")
        await this.recordCrash(e, policy, live, keepSlot);
      // A crash keeps the journal's tasks and crons (the lost work is reported from them); a reap drops its pids.
      if (!crash) await this.writeJournal();
      else await this.persistJournal();
    } finally {
      this.closing = undefined;
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
    if (terminating) return; // never a wake after a terminated agent's exit (S7 §8 step 4)
    // failed_start and internal never wake; a crash makes one automatic attempt only when work was lost (§9.2).
    const canAttempt = !keepSlot && this.stopsInProgress === 0 && !this.slots.closing();
    if (policy === "recover" && !keepSlot) {
      if (canAttempt) {
        await this.forwardFact("crashed"); // one automatic recovery is under way (S6 §9.1)
        await this.beginAttempt("crash_recovery", false);
      } else await this.forwardErrored(); // no attempt can begin: errored with none pending
    } else if ((intent?.kind === "failed_start" || intent?.kind === "internal") && attemptOwed) {
      // A human's message arrived while the failing process was still exiting (spec §9.2 step 5).
      if (canAttempt && this.messageStartsAttempt() && this.hasDeliverable())
        await this.beginAttempt(attemptOwed, false);
    } else if (intent?.kind === "hibernate") {
      if (intent.reason !== "shutdown" && intent.reason !== "archived") {
        // Only an apply-restart (or Stop crons taking it over) restarts for config: a self-edit's wake, or crons it lost.
        const applies = intent.reason === "apply_changes" || intent.reason === "crons_stopped";
        const configWake =
          applies && (wake || (intent.reason === "apply_changes" && intent.lost.crons.length > 0));
        await this.wakeAfterExit(configWake ? "apply_changes" : "queued_items");
      }
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
    wake: boolean,
  ) {
    const { reason, lost } = intent;
    const anyLost = lost.tasks.length > 0 || lost.crons.length > 0;
    if (reason !== "warm_window") await this.reportLostWork(reason, lost, intent.by);
    if (reason === "shutdown" && (turnWasOpen || anyLost))
      await this.addNotice(
        "factory_restarted",
        notices.factoryRestarted({ tasks: lost.tasks.map((t) => t.description || t.taskId) }),
      );
    else if (wake && (reason === "apply_changes" || reason === "crons_stopped"))
      // I7 §9.5: the self-edit's one waking notice, replacing `restart_crons`. After Stop crons took the hibernate
      // over, the human's `crons_stopped` notice already lists them.
      await this.addNotice(
        "config_continue",
        notices.configContinue({
          crons: reason === "apply_changes" ? lost.crons.map((c) => c.humanSchedule) : [],
        }),
      );
    else if (reason === "apply_changes" && lost.crons.length)
      await this.addNotice(
        "restart_crons",
        notices.restartCrons({ crons: lost.crons.map((c) => c.humanSchedule) }),
      );
  }

  /** Spec §9.4: `background_work_lost` when live tasks or crons died, forwarded to the manager (S6 §9.1) unless archived. */
  private async reportLostWork(
    reason: "crash" | "restart" | "terminated" | Exclude<HibernateReason, "warm_window">,
    lost: LostWork,
    by?: string,
  ) {
    if (!lost.tasks.length && !lost.crons.length) return;
    await this.append(null, {
      type: "background_work_lost",
      reason,
      ...(reason === "crons_stopped" && by ? { by } : {}),
      ...lost,
    });
    // A human stopped the crons in the open (S9 Q13): their manager isn't told.
    if (reason !== "archived" && reason !== "crons_stopped")
      await this.forwardFact("work_lost", {
        lost: {
          tasks: lost.tasks.map((t) => t.description || t.taskId),
          crons: lost.crons.map((c) => c.humanSchedule),
        },
      });
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
        { agent: this.agent.handle },
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
      else this.d.log.error({ err, agent: this.agent.handle }, what);
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
        { agent: this.agent.handle, resetsAt: e.resetsAt },
        "rate limit reached but no reset time was reported; retrying in 30 minutes",
      );
    const p = await this.d.store.pauseCredential(
      liveCredentialId(this.agent),
      new Date(exact ? reported : now + RATE_LIMIT_FALLBACK_MS),
      exact,
    );
    await this.append(this.openTurnId, {
      type: "rate_limit_paused",
      credential: p.name,
      until: p.until.toISOString(),
      exact: p.exact,
    });
    this.slots.pause(liveCredentialId(this.agent), p.until, p.exact);
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
          !this.hasDeliverable()
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
      this.d.log.error({ err, agent: this.agent.handle }, `${what}${why}`);
      await this.setErrored(stopFailedMessage(undefined), "stop_failed");
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
    // S6 §9.1: a crash during an attempt is `errored` (a failed cleanup already was, as stop_failed); a recoverable
    // crash is `crashed`, never `errored`.
    if (policy === "attempt_failed" || cleanupFailed) {
      await this.forwardErrored();
      return; // only a human acts next
    }
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
    if (!this.hasDeliverable() || this.proc) return;
    if (this.stopsInProgress > 0 || this.archived || this.noStart || this.slots.closing()) return;
    await this.wakeFromJob(reason);
  }

  /**
   * Stops the process for a pending restart once nothing would be lost (spec §6.5). Synchronous: it never awaits
   * the stop, because the `exited` that ends it is a job queued behind the caller.
   */
  private maybeRestart() {
    // S9 §10.3: a pending Stop crons wins over a pending apply-restart; it is evaluated at the same moments.
    if (this.stopCronsPending) {
      this.queueStopCronsCheck();
      return;
    }
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
      this.pendingWake = false;
      return true;
    }
    if (reason === "warm_window") {
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
      (err) => this.d.log.error({ err, agent: this.agent.handle }, what),
    );
  }

  /** One escalation job per process (a hibernate and a stop() taking it over share it). Never rejects. */
  private escalate(proc: HarnessProcess): Promise<void> {
    let p = this.escalations.get(proc);
    if (!p) {
      p = this.run(() => this.escalateNow(proc)).catch((err) =>
        this.d.log.error({ err, agent: this.agent.handle }, "stop escalation failed"),
      );
      this.escalations.set(proc, p);
    }
    return p;
  }

  /**
   * Spec §9.6, inside a job: the stop timed out, so SIGKILL (local) or stop the container (Docker), then the exit's
   * own job runs with the recorded intent. A failed escalation, or no exit within 5 s, is `stop_failed`.
   */
  private async escalateNow(
    proc: HarnessProcess,
    o: { removeOnFailure?: boolean; sweep?: boolean } = {},
  ) {
    if (proc !== this.proc) return; // its exit was recorded meanwhile
    const how = this.cleanupTarget().runtime === "docker" ? "container_stop" : "sigkill";
    this.d.log.warn({ agent: this.agent.handle, pid: proc.pid, how }, "stop timed out; escalating");
    // A sweep's retry of a stuck terminated agent records the escalation only the first time (one event per process,
    // not one per sweep); a user's Restart is a new act and always records.
    if (!(o.sweep && this.escalationRecorded.has(proc))) {
      this.escalationRecorded.add(proc);
      await this.append(null, { type: "stop_escalated", how }).catch((err) =>
        this.d.log.error({ err, agent: this.agent.handle }, "recording stop_escalated failed"),
      );
    }
    this.escalated.add(proc); // even a failed one: whenever it exits, the exit reaps
    try {
      await proc.forceKill();
    } catch (err) {
      this.d.log.error({ err, agent: this.agent.handle, pid: proc.pid }, "escalation failed");
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
      }).catch((err) => this.d.log.error({ err, agent: this.agent.handle }, "stop_failed failed"));
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
    this.pendingWake = false;
    this.d.log.error({ agent: this.agent.handle, pid: proc.pid }, "the process can't be stopped");
    // setErrored sets the in-memory truth first; the DB may be what failed.
    await this.setErrored(stopFailedMessage(proc.pid), "stop_failed").catch(() => {});
    // Restart of a stop_failed agent makes one more escalation try (spec §9.6): don't cache this one.
    this.escalations.delete(proc);
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
      this.warmArmedAt = Date.now();
      this.armWarmTimer(this.warmWindowMs());
    }
    this.updateCronExpiry();
  }

  /** The running process's warm window (I2 §6.2), else the factory default read live (S10 §8.2, Q8). */
  private warmWindowMs(): number {
    const minutes =
      this.started?.config.warmWindowMinutes ??
      this.d.defaultWarmWindowMinutes?.() ??
      DEFAULT_WARM_WINDOW_MINUTES;
    return minutes * 60_000;
  }

  /** Arms the warm timer to fire in `delayMs` (at once when ≤ 0). */
  private armWarmTimer(delayMs: number) {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => {
        void this.run(async () => {
          if (this.warmTimer !== timer) return; // cancelled, or a newer window began
          this.warmTimer = undefined;
          if (this.beginHibernate("warm_window")) this.publishStatus(); // re-checks hibernatable
        });
      },
      Math.max(0, delayMs), // at most a day (the window is capped at 1440 minutes)
    );
    this.warmTimer = timer;
  }

  /**
   * S10 §8.2: the default warm window or the member-update debounce changed. A started config that omits the window
   * re-arms its armed warm timer from when it was armed (firing at once when that is past); one that holds a window
   * keeps it. The member-update timer re-arms from the recomputed due time at the end of the job.
   */
  async settingsChanged(): Promise<void> {
    await this.run(async () => {
      if (this.started?.config.warmWindowMinutes === undefined && this.warmTimer) {
        clearTimeout(this.warmTimer);
        this.warmTimer = undefined;
        const armedAt = this.warmArmedAt ?? Date.now();
        this.armWarmTimer(armedAt + this.warmWindowMs() - Date.now());
      }
    });
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
            this.cronsMayHaveEnded();
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
    if (this.crons.size !== before) {
      await this.writeJournal();
      this.cronsMayHaveEnded();
    }
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
          { agent: this.agent.handle, owed: this.owedNotifications },
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
        { err, agent: this.agent.handle, pid: proc.pid },
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
        this.d.log.error({ err, agent: this.agent.handle }, "journal snapshot job failed"),
      );
    }, JOURNAL_SNAPSHOT_MS);
    this.snapshotTimer = timer;
  }

  /** `by` is the sender as prose writes it: `@handle` for a human or an agent. */
  private async urgentInterrupt(by: string) {
    // idle → normal send; hold active → no second interrupt; a compact in flight is never interrupted (it
    // waits behind the barrier instead)
    if (!this.proc || !this.openTurnId || this.hold || this.compactInFlight) return;
    try {
      await this.beginInterruptHold(by);
    } catch (err) {
      // The process is going away: skip the interrupt and the hold. The message stays queued and the coming
      // `exited` cleans up; this is not an internal error.
      if (err instanceof ProcessNotRunningError) return;
      throw err;
    }
  }

  /**
   * U3 §6.3 (D1): the interrupt shared by Stop and an urgent send. Writes the control, sets the hold with its fallback,
   * appends the `control{interrupt}` event and publishes the queue, all in the caller's job, so a `turn_end` can't
   * slip in between. The callers check the guards (a process, an open turn, no hold, no compaction). A rejected
   * control write (`ProcessNotRunningError`) sets no hold and is rethrown for the caller to map.
   */
  private async beginInterruptHold(by: string): Promise<void> {
    if (!this.proc) return;
    await this.proc.control("interrupt");
    const hold = setTimeout(() => {
      this.d.log.warn(
        { agent: this.agent.handle },
        "no result within the interrupt hold timeout; sending anyway",
      );
      void this.run(async () => {
        if (this.hold !== hold) return; // already released (turn_end or exited); never release a newer hold
        this.releaseHold();
        try {
          await this.append(this.openTurnId, { type: "interrupt_unconfirmed" });
          if (this.restartNowPending) await this.beginRestartNowStop();
          else await this.flush();
          this.maybeRestart();
        } catch (err) {
          if (this.proc) await this.onJobFailure(this.proc, err);
          else
            this.d.log.error(
              { err, agent: this.agent.handle },
              "flush after the interrupt hold failed",
            );
        }
        this.publishStatus();
      });
    }, this.d.holdTimeoutMs ?? 10_000);
    this.hold = hold;
    await this.append(this.openTurnId, { type: "control", cmd: "interrupt", by });
    this.publishQueue(); // queued items now read "stopping"
  }

  /** Ends the interrupt hold; the queue is republished so its items stop reading "stopping" (U3 §6.3). */
  private releaseHold() {
    if (!this.hold) return;
    clearTimeout(this.hold);
    this.hold = undefined;
    this.publishQueue();
  }

  /**
   * Strict FIFO from the head while allowed (spec §8.3). Never starts a process. Holds everything during a stop and
   * while the credential is paused (spec §7.2; an urgent interrupt is written outside the flush).
   */
  private async flush() {
    if (this.terminated) return; // S7 §8 step 1: no batch write once latched
    while (
      this.proc &&
      !this.terminated && // a latch set while a batch was being written stops the next one
      !this.stopping &&
      !this.restartNowPending && // a cut restart writes nothing to the old process (I7 §9.2.1 step 1)
      !this.credentialPaused() &&
      !this.hold &&
      !this.compactInFlight &&
      !this.rawInFlight &&
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
        this.compactFailedSeen = false;
        this.selfCompact = head.self ? { failed: false } : undefined;
        await this.append(null, {
          type: "control",
          cmd: "compact",
          by: head.by,
          ...(head.focus ? { arg: head.focus } : {}),
        });
        this.publishQueue();
        break;
      }
      if (head.kind === "raw") {
        if (this.openTurnId || this.awaiting.length || this.inFlight.length) break;
        await this.writeRaw(head);
        break;
      }
      const run: MessageEntry[] = [];
      while (this.queue[0]?.kind === "message") run.push(this.queue.shift() as MessageEntry);
      // I2 §7.3: a config notice newer than this process stays queued for the next one (it is passive, see below).
      const kept = run.filter((e) => this.forNextProcess(e));
      const batch = run.filter((e) => !kept.includes(e));
      // S9 §10.3: a passive item alone is never written; it waits for a batch with something else. A compact or a
      // command queued behind it goes ahead (flush otherwise cuts a batch at the first non-message entry).
      if (batch.every(isPassive)) {
        this.queue.unshift(...run);
        const at = this.queue.findIndex((e) => e.kind !== "message");
        if (at > 0 && this.queue.slice(0, at).every(isPassive)) {
          const [c] = this.queue.splice(at, 1);
          if (c) this.queue.unshift(c);
          continue;
        }
        break;
      }
      let written: boolean;
      try {
        written = await this.writeBatch(batch);
      } finally {
        this.queue.unshift(...kept); // ahead of a rejected batch too: notices lead
      }
      if (!written) break; // a rejected write leaves the batch at the head: stop, don't spin
    }
  }

  /**
   * I1 §5.1: writes the head raw entry as one user line, on its own, then sets the barrier and records
   * `operator_input`. A rejected write leaves it at the head. A process without `raw()` can't take it: it is dropped
   * with an error log rather than blocking the queue.
   */
  private async writeRaw(head: RawEntry): Promise<void> {
    if (!this.proc) return;
    this.queue.shift();
    if (!this.proc.raw) {
      this.d.log.error({ agent: this.agent.handle }, "the harness can't take raw input; dropped");
      this.publishQueue();
      return;
    }
    try {
      await this.proc.raw(head.text);
    } catch {
      this.queue.unshift(head);
      return;
    }
    this.rawInFlight = true;
    this.rawSelf = Boolean(head.self);
    this.writtenRaw.set(head.id, head.userId ?? "");
    if (this.writtenRaw.size > WRITTEN_RAW_KEPT) {
      const [oldest] = this.writtenRaw.keys();
      if (oldest !== undefined) this.writtenRaw.delete(oldest);
    }
    await this.append(null, {
      type: "operator_input",
      text: head.text,
      by: head.by,
      byKind: head.userId ? "human" : "agent",
      entryId: head.id,
      ...(head.clientMessageId ? { clientMessageId: head.clientMessageId } : {}),
    });
    this.publishQueue();
  }

  /** I2 §7.3: a `config_changed` row created after the running process's start stamp: only the next process reads it. */
  private forNextProcess(e: MessageEntry): boolean {
    return (
      e.row.kind === "system" &&
      e.row.notice === "config_changed" &&
      this.procStartedAt !== undefined &&
      e.row.createdAt.getTime() > this.procStartedAt.getTime()
    );
  }

  /** Re-reads every `scheduled` entry of `batch` in place; entries whose row is no longer pending are removed. */
  private async refreshScheduled(batch: MessageEntry[]): Promise<void> {
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i];
      if (e?.row.kind !== "scheduled") continue;
      const fresh = await this.d.store.pendingJoined(e.row.id);
      if (fresh) e.row = fresh;
      else batch.splice(i, 1);
    }
  }

  /** False when the write was rejected (the batch is back at the head of the queue). */
  private async writeBatch(batch: MessageEntry[]): Promise<boolean> {
    const proc = this.proc;
    if (!proc) {
      this.queue.unshift(...batch);
      return false;
    }
    // S9 §8.2 rule 2: a scheduled entry may be stale (loaded by `init()`, or handed over behind a slow start): render the
    // row's current content, and drop one that is no longer pending (rejected by a termination).
    try {
      await this.refreshScheduled(batch);
    } catch (err) {
      this.queue.unshift(...batch);
      throw err;
    }
    if (!batch.length) return true;
    const ids = batch.map((m) => m.row.id);
    let envelopes: FactoryMessage[];
    try {
      envelopes = await toEnvelopes(batch, (t) => this.d.store.mentionLookup(t)); // inside the try: a throw here must not lose the batch
      await proc.send(envelopes);
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
          { type: "message_in", messages: envelopes },
          tx,
        );
        // Every write, before session_started too (S6 §11): the event that shows the rows to their recipient.
        await this.d.store.setDeliveredEventSeq(ids, out.seq, tx);
        // S9 §8.2 rule 1: the row records exactly what was rendered (a replacement that landed since is coalesced).
        await this.d.store.writeBackScheduled(
          batch.filter((e) => e.row.kind === "scheduled").map((e) => e.row),
          tx,
        );
        if (this.sessionStarted) await this.d.store.markDelivered(ids, tx);
        if (turnAtWrite) await this.d.store.setDeliveredTurn(ids, turnAtWrite, tx);
        return out;
      });
    } catch (err) {
      // Claude has the batch but nothing recorded it: keep the rows pending at the head (re-sent on the next start,
      // so it may be seen twice) and let the caller stop the process (spec §11).
      this.queue.unshift(...batch);
      throw err;
    }
    this.d.bus.publish(this.agent.id, {
      type: "session_event",
      agent: this.agentRef,
      event: dto,
    });
    this.lastActivityAt = Date.now();
    // Its own statement, after the batch's transaction committed: never inside it (S7 §10.2, the lock order of §5.7).
    this.persistActivity();
    if (this.attempting) this.attemptBatchWritten = true;
    if (!this.sessionStarted) this.inFlight.push(batch);
    const written = writtenBatch(batch, new Date().toISOString());
    if (!turnAtWrite) this.awaiting.push(written);
    else {
      this.absorbed.push(written);
      this.turnRequests.push(...requestsOf(batch));
    }
    this.publishQueue();
    this.chatChanged(sendersOf([written]));
    return true;
  }

  /** I1 §6.5: each of these humans' chat with this agent changed (never anyone else). */
  chatChanged(userIds: Iterable<string | null>): void {
    for (const u of new Set(userIds))
      if (u) this.d.bus.publishToUser(u, { type: "chat_changed", agent: this.agentRef });
  }
}
