import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type AgentOverlay,
  agentOverlaySchema,
  type ConfigDoc,
  describeChanges,
  mergeConfig,
} from "@open-factory/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { readDenyRules } from "../spawning/inherit.ts";
import { FILE_CHANGE, type TemplateChange } from "../templates/template-index.ts";
import type { RuntimeLog } from "./agent-runtime.ts";
import { configOf } from "./config-resolver.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore } from "./event-store.ts";
import type { AgentRuntimes } from "./runtimes.ts";

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** What a spawner passes on to its children at their start (S7 §6.3): its secrets and its deny rules. */
function inheritedChanged(a: ConfigDoc, b: ConfigDoc): boolean {
  if (!sameSet(strs(a.template.secrets), strs(b.template.secrets))) return true;
  const da = readDenyRules(a.settings);
  const db = readDenyRules(b.settings);
  return (
    !sameSet(da.permissionsDeny, db.permissionsDeny) ||
    !sameSet(da.softDeny, db.softDeny) ||
    !sameSet(da.hardDeny, db.hardDeny)
  );
}

/** The event's `by` for a template change (spec §7.3): "template dev", or "a file change in template dev". */
const templateBy = (e: TemplateChange) =>
  e.by === FILE_CHANGE ? `a file change in template ${e.name}` : `template ${e.name}`;

type Applied = { changes: string[]; restartChecked: boolean; done: Promise<void> };

/** The two agent reads the change path needs (a port, so the flow is testable without a database). */
export interface ConfigChangeAgents {
  /** The agents of a template that are neither archived nor terminated, persistent and spawned, by slug. */
  liveOfTemplate(template: string): Promise<AgentRow[]>;
  /** A spawner's live spawned children's ids. */
  liveChildren(spawnerId: string): Promise<string[]>;
}

export function dbConfigChangeAgents(db: Db): ConfigChangeAgents {
  return {
    liveOfTemplate: (template) =>
      db
        .select()
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.template, template),
            isNull(schema.agents.archivedAt),
            isNull(schema.agents.terminatedAt),
          ),
        )
        .orderBy(asc(schema.agents.slug)),
    liveChildren: async (spawnerId) =>
      (
        await db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.reportsTo, spawnerId),
              eq(schema.agents.kind, "ephemeral"),
              isNull(schema.agents.terminatedAt),
            ),
          )
          .orderBy(asc(schema.agents.id))
      ).map((r) => r.id),
  };
}

/**
 * I2 §7.2: the one path for template changes and overlay saves. For one agent: the change lines (`describeChanges`,
 * secret-safe) go into a `config_changed` event and the passive notice, `nextImage` is refreshed, a running process is
 * asked to restart when what it started with differs, and a spawner whose secrets or deny rules changed restarts its
 * live children. Everything on a runtime's queue is scheduled, never awaited by `overlaySaved` (it may wait behind a
 * start installing a plugin); `templateChanged` runs off the scan path and awaits it.
 */
export class ConfigChanges {
  constructor(
    private readonly d: {
      agents: ConfigChangeAgents;
      store: Pick<EventStore, "append">;
      runtimes: Pick<
        AgentRuntimes,
        "get" | "recordConfigNotice" | "requestRestart" | "setNextImage" | "imageRef" | "startedOf"
      >;
      bus: Pick<EventBus, "publishAll">;
      log: Pick<RuntimeLog, "error">;
    },
  ) {}

  /**
   * A template's last valid parse moved (spec §7.1). Every agent of that template that is neither archived nor
   * terminated, persistent and spawned, gets `apply(merge(before, overlay), merge(after, overlay))`. With no `before`
   * there is no event or notice, but running agents still get the restart check.
   */
  async templateChanged(e: TemplateChange): Promise<void> {
    // Nothing that reaches an agent moved (only keys like `description` or `projects`): no agent can differ.
    if (e.before && !describeChanges(e.before, e.after).length) return;
    const rows = await this.d.agents.liveOfTemplate(e.name);
    const by = templateBy(e);
    const done: Promise<void>[] = [];
    for (const agent of rows) {
      const overlay = overlayOf(agent);
      // An invalid overlay fails its next start closed (spec §6.1): there is no effective config to diff or run.
      if (!overlay) {
        this.d.runtimes.setNextImage(agent.id, undefined);
        continue;
      }
      try {
        const r = await this.apply(
          agent,
          by,
          e.before ? mergeConfig(e.before, overlay) : null,
          mergeConfig(e.after, overlay),
        );
        done.push(r.done);
      } catch (err) {
        this.d.log.error({ err, agent: agent.slug }, "applying a template change failed");
      }
    }
    this.d.bus.publishAll({ type: "config_changed", template: e.name });
    await Promise.all(done);
  }

  /**
   * An agent's overlay was saved (the caller committed it): `before` and `after` are the merged docs. Returns once the
   * event is written or queued; the notice and the restart are scheduled, never awaited (spec §7.2). `restartChecked`
   * says a process was running, so a restart check was scheduled: it restarts only when its `started` differs, decided
   * later in the runtime's job. A caller (A14's PUT) must not present it as "restarting". An archived agent gets the
   * event alone: its next start reads everything fresh.
   */
  async overlaySaved(
    agent: AgentRow,
    by: string,
    before: ConfigDoc,
    after: ConfigDoc,
  ): Promise<{ changes: string[]; restartChecked: boolean }> {
    const { changes, restartChecked } = await this.apply(agent, by, before, after);
    return { changes, restartChecked };
  }

  private async apply(
    agent: AgentRow,
    by: string,
    before: ConfigDoc | null,
    after: ConfigDoc,
  ): Promise<Applied> {
    const { runtimes } = this.d;
    const changes = before ? describeChanges(before, after) : [];
    if (before && !changes.length)
      return { changes, restartChecked: false, done: Promise.resolve() };
    const work: Promise<unknown>[] = [];
    const rt = await runtimes.get(agent.id);
    if (changes.length) {
      // Through the runtime when loaded, so it publishes in seq order; else straight to the store.
      if (rt) work.push(rt.appendConfigChanged(by, changes));
      else await this.d.store.append(agent.id, null, { type: "config_changed", by, changes });
      // The agent frame goes with an event only. A restart-check-only change (`before: null`) shows up through the
      // agent's own status frame (`restartPending`, `restartChanges`), which the runtime publishes.
      this.d.bus.publishAll({ type: "config_changed", agent: agent.slug });
    }
    if (agent.archivedAt || agent.terminatedAt)
      return { changes, restartChecked: false, done: this.settle(agent, work) };

    if (changes.length) work.push(runtimes.recordConfigNotice(agent.id, changes));
    if (agent.runtime === "docker") {
      const config = configOf(after, agent.runtime);
      runtimes.setNextImage(agent.id, config ? runtimes.imageRef(config) : undefined);
    }
    // Compared inside the runtime's job against a fresh `started`, so a start under way can't make it skip.
    const restartChecked = Boolean(rt?.hasProcess());
    if (restartChecked) work.push(runtimes.requestRestart(agent.id, { after }));
    if (agent.kind === "persistent") {
      // With no previous doc, compare against what the running process started with.
      const was = before ?? runtimes.startedOf(agent.id)?.doc;
      if (was && inheritedChanged(was, after)) work.push(this.restartChildren(agent.id));
    }
    return { changes, restartChecked, done: this.settle(agent, work) };
  }

  /** S7 §6.3: a child derives its secrets and deny rules from its spawner at each start, so live children restart. */
  private async restartChildren(spawnerId: string): Promise<void> {
    const kids = await this.d.agents.liveChildren(spawnerId);
    await Promise.all(kids.map((id) => this.d.runtimes.requestRestart(id)));
  }

  /** Scheduled work never rejects: a failure is logged by slug (never with a config value). */
  private settle(agent: AgentRow, work: Promise<unknown>[]): Promise<void> {
    return Promise.allSettled(work).then((results) => {
      for (const r of results)
        if (r.status === "rejected")
          this.d.log.error({ err: r.reason, agent: agent.slug }, "applying a config change failed");
    });
  }
}

/** A spawned agent's overlay is always empty (spec §6.1); undefined for an overlay that fails its schema. */
function overlayOf(agent: AgentRow): AgentOverlay | undefined {
  if (agent.kind === "ephemeral") return {};
  const parsed = agentOverlaySchema.safeParse(agent.config);
  return parsed.success ? parsed.data : undefined;
}
