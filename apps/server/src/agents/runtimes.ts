import type { AgentRow } from "@open-factory/db";
import type { HarnessDriver } from "@open-factory/harness";
import {
  type AgentStatus,
  type ConfigSnapshot,
  errorKindSchema,
  type QueueItem,
} from "@open-factory/shared";
import { LOCAL_RUNTIME_DISABLED } from "../config.ts";
import type { AgentTokens } from "../mcp/tokens.ts";
import type { Forward } from "../messaging/forwarder.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import { dockerStartError, dockerUnreachable } from "../runtime/docker/errors.ts";
import type { ProcessJournal } from "../runtime/local/journal.ts";
import type { WakeReason } from "../supervisor/slots.ts";
import { Supervisor } from "../supervisor/supervisor.ts";
import { AgentRuntime, type CleanupResult, cronZoneOf, type RuntimeLog } from "./agent-runtime.ts";
import type { ConfigResolver, Effective } from "./config-resolver.ts";
import { AgentArchivedError, AgentStartError, AgentTerminatedError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, PendingRow } from "./event-store.ts";
import { notices } from "./notices.ts";
import type { PrepareStart } from "./start.ts";

export interface RuntimesDeps {
  store: EventStore;
  bus: EventBus;
  driver: HarnessDriver;
  prepareStart: PrepareStart;
  tokens: Pick<AgentTokens, "mint" | "revoke">;
  log: RuntimeLog;
  holdTimeoutMs?: number;
  /**
   * The member update debounce in ms (S6 §8.2), read live (the `member_update_debounce_seconds` factory setting, S10
   * §8.2); the runtime's 30 s default when unset.
   */
  memberUpdateDebounceMs?: () => number;
  /** The factory default warm window in minutes, read live (S10 §8.2); the runtime's 70 when unset. */
  defaultWarmWindowMinutes?: () => number;
  /** S6 §9.1: every runtime's forwarding port (the Router's `forward`). */
  forward: (f: Forward) => Promise<void>;
  /** The server's own env; only its PATH and HOME reach the version check. */
  serverEnv?: NodeJS.ProcessEnv;
  /**
   * The local process journal (spec §12): snapshots and the verified reap. Only with the real driver: a fake
   * process's pid is not ours, and must never be journaled or signalled.
   */
  journal?: ProcessJournal;
  /** The local gate, read live (`() => localRuntimeAllowed(config)`). */
  localRuntimeAllowed?: () => boolean;
  /**
   * The Docker runtime (spec §11): the one ContainerManager built in buildApp (never a second one), the in-container
   * Claude path and the default image.
   */
  docker?: {
    containers: Pick<
      ContainerManager,
      "ensure" | "ensureImage" | "stopIfRunning" | "forceRemove" | "remove"
    >;
    claudeBin: string;
    defaultImage: string;
    /** I2 §6.2: a loaded Docker agent's `nextImage` comes from its effective config at load. */
    resolver: Pick<ConfigResolver, "effective">;
  };
}

/**
 * The local cleanup (spec §9.2 step 1, §12): reap the processes `runtime_journal` names now, each only while its start
 * time still matches. Docker agents have nothing here (`dockerCleanup` stops their container).
 */
export function localCleanup(
  store: Pick<EventStore, "agentById">,
  journal: Pick<ProcessJournal, "reap">,
): (agent: AgentRow) => Promise<CleanupResult | undefined> {
  return async (agent) => {
    if (agent.runtime !== "local") return undefined;
    let j: AgentRow["runtimeJournal"] | undefined;
    try {
      j = (await store.agentById(agent.id))?.runtimeJournal;
    } catch (err) {
      // The process did exit: what failed is the DB read, so nothing could be verified or reaped.
      throw new Error("Reading the runtime journal from the database failed; nothing was reaped", {
        cause: err,
      });
    }
    if (!j?.claude && !j?.descendants?.length) return undefined;
    const killedProcesses = await journal.reap(j);
    return killedProcesses ? { killedProcesses } : undefined;
  };
}

/**
 * The Docker cleanup (spec §9.2 step 1, §9.6, §11.3): stop the agent's container (bounded `stop({t: 5})`, never
 * removed), which kills everything in it, background shells included. A Docker error throws: the caller makes the
 * agent `stop_failed`, keeping its slot.
 */
export function dockerCleanup(
  containers: Pick<ContainerManager, "stopIfRunning">,
): (agent: AgentRow) => Promise<CleanupResult | undefined> {
  return async (agent) => {
    if (agent.runtime !== "docker") return undefined;
    return (await containers.stopIfRunning(agent.id, agent.slug))
      ? { container: "stopped" }
      : undefined;
  };
}

/** The sender as prose writes it (the urgent interrupt's `by`): `@handle` for a human, `@slug` for an agent. */
function senderLabel(row: PendingRow): string {
  if (row.fromHandle) return `@${row.fromHandle}`;
  if (row.fromSlug) return `@${row.fromSlug}`;
  if (row.kind === "scheduled") return "@scheduler";
  // S8: `task_assigned` and `task_update` have no sender columns; they are from the factory (spec §7.4).
  if (row.kind !== "message") return "@factory";
  throw new Error(`message ${row.id} has no sender`);
}

/**
 * S7 §8 step 5, from what is known without asking Docker: a terminated agent with no stop under way (a loaded
 * runtime's; an unloaded one has none) whose stop failed, whose journal still names processes, or whose container the
 * sweep's last list still showed. A termination still stopping is never stuck.
 */
function terminationStuck(
  row: { errorKind?: string | null; runtimeJournal?: AgentRow["runtimeJournal"] },
  rt: AgentRuntime | undefined,
): boolean {
  if (rt?.terminationSettling()) return false;
  const j = row.runtimeJournal;
  return (
    row.errorKind === "stop_failed" ||
    Boolean(j?.claude || j?.descendants?.length) ||
    Boolean(rt?.containerLeftListed())
  );
}

export type LiveFields = ReturnType<AgentRuntime["live"]>;

export class AgentRuntimes {
  private readonly byId = new Map<string, Promise<AgentRuntime>>();
  /** The runtimes whose init finished: the Supervisor's synchronous view. */
  private readonly loaded = new Map<string, AgentRuntime>();
  /** The one owner of the running set; every runtime starts through it. */
  readonly supervisor: Supervisor;
  constructor(private readonly d: RuntimesDeps) {
    this.supervisor = new Supervisor({
      runtimes: { get: (id) => this.loaded.get(id), all: () => this.loaded.values() },
      bus: d.bus,
      log: d.log,
      // "" names no credential: an unloaded runtime, or a terminated one whose credential was deleted (the only rows
      // with a null credential_id), is never paused by, nor counted under, any real credential's rate limit.
      credentialOf: (id) => this.loaded.get(id)?.agent.credentialId ?? "",
      rateLimits: d.store,
      load: (slug) => this.bySlug(slug),
      ...(d.docker ? { images: this.images(d.docker) } : {}),
    });
  }

  /**
   * The Supervisor's image port (spec §11.2): the image a loaded Docker agent's next start is expected to use (I2 §6.2:
   * its `nextImage`, undefined when its template was invalid at load, so that start fails closed), and a check-and-pull.
   */
  private images(docker: NonNullable<RuntimesDeps["docker"]>) {
    return {
      refOf: (id: string) => {
        const rt = this.loaded.get(id);
        return rt?.agent.runtime === "docker" ? rt.nextImage : undefined;
      },
      ensure: async (ref: string, signal: AbortSignal) => {
        try {
          await docker.containers.ensureImage(ref, signal);
        } catch (err) {
          // The registry's own error goes to the log (the Supervisor warns with it); the start fails with the same
          // words whatever the cause. Only an unreachable daemon is named as such.
          if (dockerUnreachable(err)) throw dockerStartError(err);
          throw new AgentStartError(
            `Image \`${ref}\` isn't available locally and couldn't be pulled.`,
          );
        }
      },
    };
  }

  async bySlug(slug: string): Promise<AgentRuntime | undefined> {
    const row = await this.d.store.agentBySlug(slug);
    return row ? this.runtimeOf(row) : undefined;
  }

  /** `bySlug` by id: the runtime, created and initialised on first use. */
  async load(agentId: string): Promise<AgentRuntime | undefined> {
    const loaded = this.byId.get(agentId);
    if (loaded) return loaded;
    const row = await this.d.store.agentById(agentId);
    return row ? this.runtimeOf(row) : undefined;
  }

  private runtimeOf(row: AgentRow): Promise<AgentRuntime> {
    let rt = this.byId.get(row.id);
    if (!rt) {
      const runtime = new AgentRuntime({
        agent: row,
        store: this.d.store,
        bus: this.d.bus,
        driver: this.d.driver,
        // I2 §6.2: every start reads its spawner's running config through here, so no wiring can leave it out.
        prepareStart: (agent, extra) =>
          this.d.prepareStart(agent, { ...extra, loaded: (id) => this.startedOf(id) }),
        tokens: this.d.tokens,
        log: this.d.log,
        holdTimeoutMs: this.d.holdTimeoutMs,
        ...(this.d.memberUpdateDebounceMs
          ? { memberUpdateDebounceMs: this.d.memberUpdateDebounceMs }
          : {}),
        ...(this.d.defaultWarmWindowMinutes
          ? { defaultWarmWindowMinutes: this.d.defaultWarmWindowMinutes }
          : {}),
        forward: this.d.forward,
        slots: this.supervisor,
        ...(this.d.localRuntimeAllowed ? { localRuntimeAllowed: this.d.localRuntimeAllowed } : {}),
        ...(this.d.journal ? { journal: this.d.journal } : {}),
        ...this.cleanupDeps(),
        ...(this.d.docker
          ? {
              docker: {
                containers: this.d.docker.containers,
                claudeBin: this.d.docker.claudeBin,
                onImageMissing: (ref: string) => this.supervisor.forgetImage(ref),
              },
            }
          : {}),
      });
      const pending = runtime.init().then(async () => {
        if (this.d.docker && row.runtime === "docker")
          runtime.nextImage = await this.imageAtLoad(row, this.d.docker);
        if (this.byId.get(row.id) === pending) this.loaded.set(row.id, runtime);
        return runtime;
      });
      rt = pending;
      this.byId.set(row.id, pending);
      // Evict a failed init (e.g. a DB blip) so a later lookup retries instead of failing forever.
      pending.catch(() => {
        if (this.byId.get(row.id) === pending) this.byId.delete(row.id);
      });
    }
    return rt;
  }

  /**
   * I2 §6.2: the image the effective config resolves to when the runtime loads. Undefined when it can't be read (a
   * missing or invalid template, an invalid overlay): the start then fails closed with the resolver's own error.
   */
  private async imageAtLoad(
    row: AgentRow,
    docker: NonNullable<RuntimesDeps["docker"]>,
  ): Promise<string | undefined> {
    try {
      return this.imageRef((await docker.resolver.effective(row)).config);
    } catch (err) {
      if (!(err instanceof AgentStartError))
        this.d.log.warn({ err, agent: row.slug }, "reading the config for the image failed");
      return undefined;
    }
  }

  /** I2 §6.2: the Docker image reference a config resolves to (what `setNextImage` takes); undefined for a local one. */
  imageRef(config: Pick<Effective["config"], "runtime" | "image">): string | undefined {
    if (config.runtime !== "docker" || !this.d.docker) return undefined;
    return config.image ?? this.d.docker.defaultImage;
  }

  /** I2 §6.2: a loaded runtime's next image (`ConfigChanges` refreshes it on every change); a no-op when not loaded. */
  setNextImage(agentId: string, ref: string | undefined): void {
    const rt = this.loaded.get(agentId);
    if (!rt || rt.nextImage === ref) return;
    rt.nextImage = ref;
    rt.publishStatus(); // the Image row shows it before any restart
  }

  /** What every loaded runtime's running process started with (the Library sweep reads its cache directories). */
  allStarted(): Effective[] {
    return [...this.loaded.values()].flatMap((rt) => (rt.started ? [rt.started] : []));
  }

  /** I2 §6.2: what a loaded runtime's running process started with; undefined when not loaded or not running. */
  startedOf(agentId: string): Effective | undefined {
    return this.loaded.get(agentId)?.started;
  }

  /**
   * S6 §7.3: hands a committed `message` row to its recipient. A human's send awaits the job (S3's synchronous
   * `503 agent_start_failed` and `409 agent_archived`); an agent's only enqueues it: a slow start never blocks the
   * sender's tool call, and a failure leaves the row pending (or `rejected` when archived), logged, never thrown.
   * `reason` overrides an agent sender's `agent_message` wake (S7 §5.6: a spawned agent's brief wakes it `spawned`).
   */
  async deliver(
    row: PendingRow,
    sender: "human" | "agent",
    reason?: WakeReason,
  ): Promise<QueueItem | undefined> {
    const o = { sender, fromLabel: senderLabel(row), ...(reason ? { reason } : {}) };
    if (sender === "human") {
      const rt = await this.recipientOf(row);
      return rt.deliver(row, o);
    }
    // An agent's send already committed its row: a recipient that can't be loaded (a failed init) leaves it pending
    // for the next hand-off or boot, logged; it never reaches the sender, whose retry would duplicate the message.
    let rt: AgentRuntime;
    try {
      rt = await this.recipientOf(row);
    } catch (err) {
      this.d.log.error(
        { err, agentId: row.toAgentId, message: row.id },
        "loading the recipient failed; the message stays pending",
      );
      return undefined;
    }
    void rt.deliver(row, o).catch((err: unknown) => {
      if (
        err instanceof AgentArchivedError ||
        err instanceof AgentTerminatedError ||
        err instanceof AgentStartError
      )
        this.d.log.info({ agent: rt.agent.slug, message: row.id }, err.message);
      else
        this.d.log.error(
          { err, agent: rt.agent.slug, message: row.id },
          "delivering a message failed",
        );
    });
    return undefined;
  }

  private async recipientOf(row: PendingRow): Promise<AgentRuntime> {
    if (!row.toAgentId) throw new Error(`message ${row.id} has no agent recipient`);
    const rt = await this.load(row.toAgentId);
    if (!rt) throw new Error(`message ${row.id}: recipient ${row.toAgentId} not found`);
    return rt;
  }

  /** S6 §8: hands a committed member update or peer event to its recipient; never awaited, never throws. */
  receive(row: PendingRow): void {
    const to = row.toAgentId;
    if (!to) {
      this.d.log.error({ message: row.id }, "a member update or peer event has no agent recipient");
      return;
    }
    void this.load(to)
      .then((rt) => rt?.receive(row))
      .catch((err: unknown) =>
        this.d.log.error(
          { err, agentId: to, message: row.id },
          "handing over a member update or peer event failed",
        ),
      );
  }

  /** The live status of a loaded runtime; for one not loaded, what its row says (errored or hibernated). */
  statusOf(agent: Pick<AgentRow, "id" | "status">): AgentStatus {
    const rt = this.loaded.get(agent.id);
    if (rt) return rt.statusFrame().status;
    return agent.status === "errored" ? "errored" : "hibernated";
  }

  /** One cleanup port for both runtimes: the local journal reap and the Docker container stop, by the agent's runtime. */
  private cleanupDeps(): { cleanup?: (agent: AgentRow) => Promise<CleanupResult | undefined> } {
    const local = this.d.journal ? localCleanup(this.d.store, this.d.journal) : undefined;
    const docker = this.d.docker ? dockerCleanup(this.d.docker.containers) : undefined;
    if (!local && !docker) return {};
    return {
      cleanup: async (agent) => (agent.runtime === "docker" ? docker?.(agent) : local?.(agent)),
    };
  }

  /** The runtime if it already exists. Never creates one. */
  async get(agentId: string): Promise<AgentRuntime | undefined> {
    return this.byId.get(agentId)?.catch(() => undefined);
  }

  /**
   * Refreshes a loaded runtime's row; a no-op when none is loaded. Then re-pumps the wake queue: a credential change
   * may have moved a queued agent off a paused credential (spec §5.2).
   */
  async refresh(agentId: string): Promise<void> {
    const rt = await this.get(agentId);
    if (!rt) return;
    await rt.reload();
    this.supervisor.recheckQueue();
  }

  /**
   * S10 §8.2: the default warm window or the member-update debounce changed. Every loaded runtime re-arms its warm and
   * member-update timers in its own job queue; a failure is logged, never thrown.
   */
  async settingsChanged(): Promise<void> {
    await Promise.all(
      [...this.loaded.values()].map((rt) =>
        rt
          .settingsChanged()
          .catch((err) =>
            this.d.log.error(
              { err, agent: rt.agent.slug },
              "re-arming after a settings change failed",
            ),
          ),
      ),
    );
  }

  /**
   * Applies config changes at the next safe moment (spec §13); a no-op when no runtime is loaded. `changes` (I2 §7.3)
   * are shown as `restartChanges` while it is pending; `wake` is I7's and ignored in I2. `current` re-reads the
   * effective config inside the runtime's job, which restarts only when the running process started with another one
   * (see `AgentRuntime.requestRestart`).
   */
  async requestRestart(
    agentId: string,
    opts: {
      changes?: string[];
      wake?: boolean;
      current?: () => Promise<ConfigSnapshot | undefined>;
    } = {},
  ): Promise<void> {
    await (await this.get(agentId))?.requestRestart(opts);
  }

  /**
   * I2 §7.3: records config change lines in the agent's one pending `config_changed` notice (merged), whatever its
   * state: through the runtime when one exists (a loading one is awaited first, so the two can't race), else through
   * the store. A runtime whose load began during that store write may have read its queue before the row committed,
   * so it adopts the row afterwards. The lines are `describeChanges` output: never a raw config value.
   */
  async recordConfigNotice(agentId: string, lines: string[]): Promise<void> {
    if (!lines.length) return;
    const rt = await this.get(agentId);
    if (rt) return rt.recordConfigNotice(lines);
    const row = await this.d.store.createNotice({
      toAgentId: agentId,
      notice: "config_changed",
      body: notices.configChanged(lines),
    });
    await (await this.get(agentId))?.adoptNotice(row.id);
  }

  /**
   * Hands a notice row that was written in another transaction (the loop guard's manager notices) to the agent's
   * runtime, without waking it. Nothing when the agent has no runtime.
   */
  async adoptNotice(agentId: string, rowId: string): Promise<void> {
    await (await this.get(agentId))?.adoptNotice(rowId);
  }

  /**
   * I7 §8.2: records an agent actor's change to `reportId`'s configuration in its manager's one pending
   * `report_config_changed` notice for that report (merged), through the manager's runtime when one exists, as
   * `recordConfigNotice` does. Nothing for an archived or terminated manager. The lines are `describeChanges` output.
   */
  async recordReportNotice(
    managerId: string,
    reportId: string,
    by: string,
    lines: string[],
  ): Promise<void> {
    if (!lines.length) return;
    const manager = await this.d.store.agentById(managerId);
    if (!manager || manager.archivedAt || manager.terminatedAt) return;
    const rt = await this.get(managerId);
    if (rt) return rt.recordReportNotice(reportId, by, lines);
    const report = await this.d.store.agentById(reportId);
    if (!report) return;
    const row = await this.d.store.createNotice({
      toAgentId: managerId,
      notice: "report_config_changed",
      body: notices.reportConfigChanged({ by, report: report.slug, lines }),
      subjectAgentId: reportId,
    });
    await (await this.get(managerId))?.adoptNotice(row.id);
  }

  /**
   * Runtime-only fields; defaults for an agent that has no runtime yet. `runtimeDisabled` comes from the row and the
   * config, not the runtime: spec §8.2 sends it for every local agent while the gate is off, loaded or not (after a
   * boot nothing is loaded until it is touched).
   */
  async liveFields(
    agentId: string,
    row: {
      status: string;
      lastError?: string | null;
      errorKind?: string | null;
      runtime?: string;
      terminatedAt?: Date | null;
      runtimeJournal?: AgentRow["runtimeJournal"];
    },
  ): Promise<LiveFields & { stuck?: true }> {
    const rt = await this.get(agentId);
    const stuck = row.terminatedAt && terminationStuck(row, rt) ? { stuck: true as const } : {};
    if (rt) return { ...rt.live(), ...stuck };
    const errored = row.status === "errored";
    const kind = errorKindSchema.safeParse(row.errorKind);
    return {
      // An unloaded terminated agent: nothing runs for it, so it shows as what it is.
      status: row.terminatedAt ? "terminated" : errored ? "errored" : "hibernated",
      ...(errored && row.lastError ? { lastError: row.lastError } : {}),
      ...(errored && kind.success ? { errorKind: kind.data } : {}),
      ...(row.runtime === "local" && !(this.d.localRuntimeAllowed?.() ?? true)
        ? { runtimeDisabled: LOCAL_RUNTIME_DISABLED }
        : {}),
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
      restartChanges: [],
      waitingOn: { tasks: [], crons: 0 },
      crons: [],
      cronZone: cronZoneOf(row.runtime === "docker" ? "docker" : "local"),
      stopCronsPending: false,
      ...stuck,
    };
  }

  /**
   * Shutdown (spec §5.6, §6.6): the closing latch first (the Supervisor's, then every runtime's, including those whose
   * init finished after it), so nothing can start once shutdown has begun; then `stopAll`.
   */
  async close(): Promise<void> {
    this.supervisor.close();
    for (const rt of await this.all()) rt.setNoStart();
    await this.stopAll();
  }

  /**
   * `hibernate("shutdown")` (or `"archived"`) on every runtime in parallel, each waiting for its exit and its job queue
   * to drain, so the shutdown budget doesn't grow with the number of agents. allSettled throughout: one failed init or
   * stop must not keep the other runtimes' processes running past shutdown.
   */
  async stopAll(): Promise<void> {
    const stops = await Promise.allSettled((await this.all()).map((rt) => rt.stop()));
    for (const r of stops)
      if (r.status === "rejected") this.d.log.error({ err: r.reason }, "Stopping an agent failed");
  }

  /** Every runtime whose init succeeded, once every init in flight has settled. */
  private async all(): Promise<AgentRuntime[]> {
    const inits = await Promise.allSettled(this.byId.values());
    return inits.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }
}
