import { checkClaudeVersion, type HarnessDriver, MIN_CLAUDE_VERSION } from "@open-factory/harness";
import { DEFAULT_MAX_RUNNING_AGENTS } from "../config.ts";
import { Supervisor } from "../supervisor/supervisor.ts";
import { AgentRuntime, type RuntimeLog } from "./agent-runtime.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore } from "./event-store.ts";
import type { PrepareStart } from "./start.ts";

export interface RuntimesDeps {
  store: EventStore;
  bus: EventBus;
  driver: HarnessDriver;
  prepareStart: PrepareStart;
  log: RuntimeLog;
  holdTimeoutMs?: number;
  /** The server's own env; only its PATH and HOME reach the version check. */
  serverEnv?: NodeJS.ProcessEnv;
  /** The cap (`FACTORY_MAX_RUNNING_AGENTS`); defaults to the config default. */
  maxRunningAgents?: number;
}

/** `claude --version` runs on the host, so it gets the plugin CLI's rule (spec §11.7): never the
 *  agent's env or its agent-writable `CLAUDE_CONFIG_DIR`, only `PATH` and the host `HOME`. */
export function versionCheckEnv(serverEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (serverEnv.PATH) env.PATH = serverEnv.PATH;
  if (serverEnv.HOME) env.HOME = serverEnv.HOME;
  return env;
}

export type LiveFields = ReturnType<AgentRuntime["live"]>;

export class AgentRuntimes {
  private readonly byId = new Map<string, Promise<AgentRuntime>>();
  /** The runtimes whose init finished: the Supervisor's synchronous view. */
  private readonly loaded = new Map<string, AgentRuntime>();
  private versionChecked = false;
  /** The one owner of the cap; every runtime starts through it. */
  readonly supervisor: Supervisor;
  constructor(private readonly d: RuntimesDeps) {
    this.supervisor = new Supervisor({
      max: d.maxRunningAgents ?? DEFAULT_MAX_RUNNING_AGENTS,
      runtimes: { get: (id) => this.loaded.get(id), all: () => this.loaded.values() },
      bus: d.bus,
      log: d.log,
      credentialOf: (id) => this.loaded.get(id)?.agent.credentialId ?? "",
      rateLimits: d.store,
      load: (slug) => this.bySlug(slug),
    });
  }

  async bySlug(slug: string): Promise<AgentRuntime | undefined> {
    const row = await this.d.store.agentBySlug(slug);
    if (!row) return undefined;
    let rt = this.byId.get(row.id);
    if (!rt) {
      const runtime = new AgentRuntime({
        agent: row,
        store: this.d.store,
        bus: this.d.bus,
        driver: this.d.driver,
        prepareStart: this.d.prepareStart,
        log: this.d.log,
        holdTimeoutMs: this.d.holdTimeoutMs,
        slots: this.supervisor,
        // Local agents only: a Docker agent's claude runs in its image, not on the host.
        onFirstStart: (spec) => {
          if (spec.runtime === "local") this.checkVersionOnce(spec.claudeBin);
        },
      });
      const pending = runtime.init().then(() => {
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

  /** Applies config changes at the next safe moment (spec §13); a no-op when no runtime is loaded. */
  async requestRestart(agentId: string): Promise<void> {
    await (await this.get(agentId))?.requestRestart();
  }

  /** Runtime-only fields; defaults for an agent that has no runtime yet. */
  async liveFields(agentId: string, row: { status: string }): Promise<LiveFields> {
    const rt = await this.get(agentId);
    if (rt) return rt.live();
    return {
      status: row.status === "errored" ? "errored" : "hibernated",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
      waitingOn: { tasks: [], crons: 0 },
    };
  }

  /**
   * In parallel, so the shutdown budget doesn't grow with the number of agents. allSettled throughout:
   * one failed init or stop must not keep the other runtimes' processes running past shutdown.
   */
  async stopAll(): Promise<void> {
    const inits = await Promise.allSettled(this.byId.values());
    const all = inits.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const stops = await Promise.allSettled(
      all.map((rt) => rt.stop({ graceMs: 3000, termWaitMs: 10_000 })),
    );
    for (const r of stops)
      if (r.status === "rejected") this.d.log.error({ err: r.reason }, "Stopping an agent failed");
  }

  private checkVersionOnce(bin: string) {
    if (this.versionChecked) return;
    this.versionChecked = true;
    void checkClaudeVersion(bin, versionCheckEnv(this.d.serverEnv ?? process.env)).then(
      ({ version, tooOld }) => {
        if (version) this.d.log.info({ version }, "Claude Code version");
        if (tooOld)
          this.d.log.warn(
            { version, minimum: MIN_CLAUDE_VERSION },
            "Claude Code is older than the version S3 was verified on",
          );
      },
    );
  }
}
