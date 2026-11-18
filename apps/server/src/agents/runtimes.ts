import { checkClaudeVersion, type HarnessDriver, MIN_CLAUDE_VERSION } from "@open-factory/harness";
import type { AgentSummary } from "@open-factory/shared";
import type { Config } from "../config.ts";
import { AgentRuntime, type RuntimeLog } from "./agent-runtime.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore } from "./event-store.ts";

export interface RuntimesDeps {
  store: EventStore;
  bus: EventBus;
  driver: HarnessDriver;
  config: Config;
  log: RuntimeLog;
  serverEnv?: NodeJS.ProcessEnv;
  holdTimeoutMs?: number;
}

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
        config: this.d.config,
        log: this.d.log,
        serverEnv: this.d.serverEnv,
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

  async list(): Promise<AgentSummary[]> {
    const rows = await this.d.store.listAgents();
    const out: AgentSummary[] = [];
    for (const r of rows) {
      const rt = await this.bySlug(r.slug);
      if (rt) out.push(rt.summary());
    }
    return out;
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
