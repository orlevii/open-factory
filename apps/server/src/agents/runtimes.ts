import { checkClaudeVersion, type HarnessDriver } from "@open-factory/harness";
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
      rt = runtime.init().then(() => runtime);
      this.byId.set(row.id, rt);
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

  /** In parallel, so the shutdown budget doesn't grow with the number of agents. */
  async stopAll(): Promise<void> {
    const all = await Promise.all(this.byId.values());
    await Promise.all(all.map((rt) => rt.stop({ graceMs: 3000, termWaitMs: 10_000 })));
  }

  private checkVersionOnce(bin: string, env: Record<string, string>) {
    if (this.versionChecked) return;
    this.versionChecked = true;
    void checkClaudeVersion(bin, env).then(({ version, tooOld }) => {
      if (version) this.d.log.info({ version }, "Claude Code version");
      if (tooOld)
        this.d.log.warn(
          { version, minimum: "2.1.327" },
          "Claude Code is older than the version S3 was verified on",
        );
    });
  }
}
