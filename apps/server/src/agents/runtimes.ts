import { checkClaudeVersion, type HarnessDriver, MIN_CLAUDE_VERSION } from "@open-factory/harness";
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
}

export type LiveFields = ReturnType<AgentRuntime["live"]>;

export class AgentRuntimes {
  private readonly byId = new Map<string, Promise<AgentRuntime>>();
  private versionChecked = false;
  constructor(private readonly d: RuntimesDeps) {}

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
        onFirstStart: (spec) => this.checkVersionOnce(spec.claudeBin, spec.env),
      });
      const pending = runtime.init().then(() => runtime);
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

  /** Refreshes a loaded runtime's row; a no-op when none is loaded. */
  async refresh(agentId: string): Promise<void> {
    await (await this.get(agentId))?.reload();
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

  private checkVersionOnce(bin: string, env: Record<string, string>) {
    if (this.versionChecked) return;
    this.versionChecked = true;
    void checkClaudeVersion(bin, env).then(({ version, tooOld }) => {
      if (version) this.d.log.info({ version }, "Claude Code version");
      if (tooOld)
        this.d.log.warn(
          { version, minimum: MIN_CLAUDE_VERSION },
          "Claude Code is older than the version S3 was verified on",
        );
    });
  }
}
