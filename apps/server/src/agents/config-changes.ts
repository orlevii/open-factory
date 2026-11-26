import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type Actor,
  type AgentOverlay,
  actorTag,
  agentOverlaySchema,
  type ConfigDoc,
  type ConfigSnapshot,
  describeChanges,
  type Library,
  mergeConfig,
} from "@open-factory/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { readDenyRules } from "../spawning/inherit.ts";
import { FILE_CHANGE, type TemplateChange } from "../templates/template-index.ts";
import type { RuntimeLog } from "./agent-runtime.ts";
import { type ConfigResolver, configOf } from "./config-resolver.ts";
import { AgentStartError } from "./errors.ts";
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

/**
 * The event's `by` for a template change (spec §7.3, §8.1): "@hr in template dev" for an agent's write, else "template
 * dev", or "a file change in template dev".
 */
const templateBy = (e: TemplateChange) =>
  e.actor?.kind === "agent"
    ? `${actorTag(e.actor)} in template ${e.name}`
    : e.by === FILE_CHANGE
      ? `a file change in template ${e.name}`
      : `template ${e.name}`;

type Applied = { changes: string[]; restartChecked: boolean; done: Promise<void> };

/** The agent reads the change path needs (a port, so the flow is testable without a database). */
export interface ConfigChangeAgents {
  /** The agents of a template that are neither archived nor terminated, persistent and spawned, by slug. */
  liveOfTemplate(template: string): Promise<AgentRow[]>;
  /** A spawner's live spawned children's ids. */
  liveChildren(spawnerId: string): Promise<string[]>;
  /** Every agent that is neither archived nor terminated (persistent or spawned), by slug: what a library change checks. */
  allLive(): Promise<AgentRow[]>;
  /**
   * The agent's effective doc and Library now: its row read fresh, then the resolver. Undefined when it can't be
   * resolved (gone, a missing or broken template, an invalid overlay). The runtime calls it inside its job to decide a
   * restart.
   */
  currentEffective(agentId: string): Promise<ConfigSnapshot | undefined>;
}

export function dbConfigChangeAgents(
  db: Db,
  resolver: Pick<ConfigResolver, "effective">,
): ConfigChangeAgents {
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
    allLive: () =>
      db
        .select()
        .from(schema.agents)
        .where(and(isNull(schema.agents.archivedAt), isNull(schema.agents.terminatedAt)))
        .orderBy(asc(schema.agents.slug)),
    currentEffective: async (agentId) => {
      const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!row) return undefined;
      try {
        const { doc, library } = await resolver.effective(row);
        return { doc, library };
      } catch (err) {
        if (err instanceof AgentStartError) return undefined;
        throw err;
      }
    },
  };
}

/**
 * I2 §7.2: the one path for template changes and overlay saves. For one agent: the change lines (`describeChanges`,
 * secret-safe) go into a `config_changed` event and the passive notice, `nextImage` is refreshed, a running process is
 * asked to restart when what it started with differs, and a spawner whose secrets or deny rules changed restarts its
 * live children. Everything on a runtime's queue is scheduled, never awaited by `overlaySaved`; `templateChanged` runs
 * off the scan path and awaits it.
 */
export class ConfigChanges {
  constructor(
    private readonly d: {
      agents: ConfigChangeAgents;
      store: Pick<EventStore, "append">;
      runtimes: Pick<
        AgentRuntimes,
        | "get"
        | "recordConfigNotice"
        | "recordReportNotice"
        | "requestRestart"
        | "setNextImage"
        | "imageRef"
        | "startedOf"
      >;
      bus: Pick<EventBus, "publishAll">;
      log: Pick<RuntimeLog, "error">;
      /** What the Library resolves a merged doc to (spec §8.1), for both sides of a comparison. */
      resolver: Pick<ConfigResolver, "libraryOf">;
      /** A library change rescans the templates, so their stored issues don't go stale (spec §8.2). */
      templates: { scan(): Promise<unknown> };
    },
  ) {}

  private async snapshot(doc: ConfigDoc): Promise<ConfigSnapshot> {
    return { doc, library: await this.d.resolver.libraryOf(doc) };
  }

  /**
   * A template's last valid parse moved (spec §7.1). Every agent of that template that is neither archived nor
   * terminated, persistent and spawned, gets `apply(merge(before, overlay), merge(after, overlay))`. With no `before`
   * there is no event or notice, but running agents still get the restart check.
   */
  async templateChanged(e: TemplateChange): Promise<void> {
    // The template's own views (its issues, "Used by") refresh on every change, even one no agent sees.
    this.d.bus.publishAll({ type: "config_changed", template: e.name });
    // Nothing that reaches an agent moved (only keys like `description` or `projects`): no agent can differ.
    if (
      e.before &&
      !describeChanges(await this.snapshot(e.before), await this.snapshot(e.after)).length
    )
      return;
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
          e.before ? await this.snapshot(mergeConfig(e.before, overlay)) : null,
          await this.snapshot(mergeConfig(e.after, overlay)),
          e.actor ?? null,
        );
        done.push(r.done);
      } catch (err) {
        this.d.log.error({ err, agent: agent.slug }, "applying a template change failed");
      }
    }
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
    actor: Actor,
    before: ConfigDoc,
    after: ConfigDoc,
  ): Promise<{ changes: string[]; restartChecked: boolean }> {
    const { changes, restartChecked } = await this.apply(
      agent,
      actorTag(actor),
      await this.snapshot(before),
      await this.snapshot(after),
      actor,
    );
    return { changes, restartChecked };
  }

  /**
   * What the Library resolves these skill names to right now. The caller of `libraryChanged` takes it before it mutates
   * the Library and passes it back as `before`, so an agent with no running process can still say what changed.
   */
  async captureLibrary(skills: string[]): Promise<Library> {
    return this.d.resolver.libraryOf({
      template: { skills },
      settings: {},
      mcp: { mcpServers: {} },
    });
  }

  /**
   * The Library moved (spec §8.3): a GitHub update, an Undo that restores a name. Called
   * after the Library lock is released. The templates are rescanned first, so a skill that went missing
   * shows as an issue. Then every non-archived, non-terminated agent that uses one of the names gets
   * `apply(agent, by, before, now)`: `before` is what its process started with when it runs, else its effective config
   * now with the changed names' refs replaced by `e.before` (captured by the caller before the mutation); `now` is a
   * fresh resolve. The event, the passive notice and, for a running agent, the restart check follow I2 §7.3.
   */
  async libraryChanged(e: { skills?: string[]; by: string; before?: Library }): Promise<void> {
    try {
      await this.d.templates.scan();
    } catch (err) {
      this.d.log.error({ err }, "rescanning templates after a library change failed");
    }
    const skills = new Set(e.skills);
    const uses = (l: Library) => Object.keys(l.skills).some((n) => skills.has(n));
    const pick = (
      now: Record<string, string>,
      was: Record<string, string> | undefined,
      names: Set<string>,
    ) =>
      Object.fromEntries(
        Object.entries(now).map(([n, ref]) => [n, names.has(n) ? (was?.[n] ?? ref) : ref]),
      );
    const done: Promise<void>[] = [];
    for (const agent of await this.d.agents.allLive()) {
      try {
        const started = this.d.runtimes.startedOf(agent.id);
        const now = await this.d.agents.currentEffective(agent.id);
        if (!now) continue;
        if (!uses(started ? started.library : now.library)) continue;
        const before: ConfigSnapshot = started
          ? { doc: started.doc, library: started.library }
          : {
              doc: now.doc,
              library: { skills: pick(now.library.skills, e.before?.skills, skills) },
            };
        const r = await this.apply(agent, e.by, before, now, null);
        done.push(r.done);
      } catch (err) {
        this.d.log.error({ err, agent: agent.slug }, "applying a library change failed");
      }
    }
    await Promise.all(done);
  }

  private async apply(
    agent: AgentRow,
    by: string,
    before: ConfigSnapshot | null,
    after: ConfigSnapshot,
    /** Who made the change; null for a file change or a Library change. */
    actor: Actor | null,
  ): Promise<Applied> {
    const { runtimes } = this.d;
    // An agent that edits its own configuration is woken by the restart it asked for (spec §9.5).
    const wake = actor?.kind === "agent" && actor.id === agent.id;
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
    // I7 §8.2: an agent actor's change tells the agent's manager, unless the manager is the actor (it knows).
    if (
      changes.length &&
      actor?.kind === "agent" &&
      agent.reportsTo &&
      agent.reportsTo !== actor.id
    )
      work.push(runtimes.recordReportNotice(agent.reportsTo, agent.id, actorTag(actor), changes));
    if (agent.runtime === "docker") {
      const config = configOf(after.doc, agent.runtime);
      runtimes.setNextImage(agent.id, config ? runtimes.imageRef(config) : undefined);
    }
    // Decided inside the runtime's job, against a fresh `started` and the config re-read there: `after` was computed
    // from rows read earlier, so a request built on it could cancel a restart a newer change needs (I2 §7.2).
    const restartChecked = Boolean(rt?.hasProcess());
    if (restartChecked)
      work.push(
        runtimes.requestRestart(agent.id, {
          current: () => this.d.agents.currentEffective(agent.id),
          ...(wake ? { wake } : {}),
        }),
      );
    if (agent.kind === "persistent") {
      // With no previous doc, compare against what the running process started with.
      const was = before?.doc ?? runtimes.startedOf(agent.id)?.doc;
      if (was && inheritedChanged(was, after.doc)) work.push(this.restartChildren(agent.id));
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
