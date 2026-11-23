import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import { sendMessagesBodySchema } from "@open-factory/shared";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventStore, Exec, PendingRow } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { type Config, localRuntimeAllowed } from "../config.ts";
import { isSlugUnique } from "../db-errors.ts";
import { FieldError } from "../errors.ts";
import type { SpawnArgs, SpawnResult } from "../mcp/tools/spawn-agent.ts";
import { claimHandle, handleKind } from "../messaging/principals.ts";
import type { Router } from "../messaging/router.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { WorkspaceError } from "../workspace/links.ts";
import { templateCopyDir } from "../workspace/paths.ts";
import { PluginInstallError } from "../workspace/plugins.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { droppedNote, type Inherited, inheritFrom, readDenyRules } from "./inherit.ts";
import { maySpawn } from "./may-spawn.ts";
import { spawnSlug } from "./slug.ts";

type Template = Awaited<ReturnType<TemplateIndex["loadValid"]>>;
type Granted = Extract<Inherited, { ok: true }>;
type Refused = { ok: false; message: string };

const HOUR_MS = 3_600_000;
const SHUTTING_DOWN = "The factory is shutting down; spawn again after it restarts.";
const CANT_SPAWN = "You can't spawn agents.";
const fail = (message: string): Refused => ({ ok: false, message });
const taken = (slug: string) => fail(`@${slug} is taken; pick another suffix or leave it out.`);

/**
 * `spawn_agent` (S7 §5.2): pre-checks without a lock, materialize outside any lock, then one locked transaction that
 * re-checks everything and writes the child, its grants, its brief, its `spawned` event and the peer rows. A spawned
 * agent never holds anything its spawner lacks (§6, `inheritFrom`).
 */
/** Who an agent that can't fix a problem itself goes to: its manager, or else a person (spec §4.5). */
const askFor = (agent: Pick<AgentRow, "reportsTo">) =>
  agent.reportsTo ? "ask your manager" : "ask a human (list_peers lists them)";

export class SpawnService {
  private readonly now: () => number;

  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      templates: TemplateIndex;
      workspace: Workspace;
      router: Pick<Router, "persistPeerEvents" | "handOffHeldRows" | "handOffBrief">;
      runtimes: AgentRuntimes;
      config: Config;
      log: RuntimeLog;
      /** The closing latch (spec §5.2 step 1). */
      closing(): boolean;
      random?: () => string;
      now?: () => number;
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  async spawn(callerId: string, args: SpawnArgs, toolUseId: string | null): Promise<SpawnResult> {
    if (this.d.closing()) return fail(SHUTTING_DOWN);
    const caller = await this.d.store.agentById(callerId);
    if (!caller || !maySpawn(caller)) return fail(CANT_SPAWN);
    if (!caller.config.canSpawn.includes(args.template))
      return fail(`You can't spawn template ${args.template}.`);
    const desc = args.description.trim();
    if (!desc || desc.length > 500) return fail("Give a description of 1 to 500 characters.");
    const body = sendMessagesBodySchema.shape.body.safeParse(args.prompt);
    if (!body.success) return fail(body.error.issues[0]?.message ?? "The prompt is invalid.");
    const prompt = body.data;
    let tpl: Template;
    try {
      tpl = await this.d.templates.loadValid(args.template);
    } catch {
      return fail(`Template ${args.template} is missing or invalid; ${askFor(caller)} to fix it.`);
    }
    // Pre-checks without a lock (spec §5.2 step 2): nothing is materialized for a refused spawn.
    const pre = await this.check(caller, tpl, this.d.db);
    if (!pre.ok) return pre;
    for (let attempt = 0; attempt < (args.suffix !== undefined ? 1 : 5); attempt++) {
      const named = spawnSlug(args.template, args.suffix, this.d.random);
      if (!named.ok) return fail(named.message);
      if (await handleKind(this.d.db, named.slug)) {
        if (named.explicit) return taken(named.slug);
        continue;
      }
      const made = await this.materialize(
        named.slug,
        args.template,
        desc,
        tpl,
        caller,
        pre.inherited,
      );
      if (made === "taken") {
        if (named.explicit) return taken(named.slug);
        continue;
      }
      if (made !== "ok") return made;
      const done = await this.insert(
        caller,
        named.slug,
        args.template,
        desc,
        prompt,
        tpl,
        toolUseId,
      );
      if (done === "taken") {
        if (named.explicit) return taken(named.slug);
        continue;
      }
      return done;
    }
    return fail(`Couldn't find a free name for ${args.template}-xxxx; pass a suffix.`);
  }

  /**
   * The live count (§5.4), the hourly rate (§5.5) and the inheritance rule (§6) against the spawner's current state,
   * read through `db` (the pool for the pre-check, the locked transaction for the re-check).
   */
  private async check(
    spawner: AgentRow,
    tpl: Template,
    db: Exec,
  ): Promise<{ ok: true; inherited: Granted } | Refused> {
    const { agents } = schema;
    const live = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(
        and(
          eq(agents.reportsTo, spawner.id),
          eq(agents.kind, "ephemeral"),
          isNull(agents.terminatedAt),
        ),
      )
      .orderBy(asc(agents.slug));
    const max = spawner.config.maxLiveSpawns;
    if (live.length >= max)
      return fail(
        `You have ${live.length} live spawned agents (max ${max}): ${live.map((r) => `@${r.slug}`).join(", ")}. Terminate one first.`,
      );
    const [recent] = await db
      .select({ n: count() })
      .from(agents)
      .where(
        and(
          eq(agents.reportsTo, spawner.id),
          eq(agents.kind, "ephemeral"),
          gt(agents.createdAt, new Date(this.now() - HOUR_MS)),
        ),
      );
    const cap = this.d.config.maxSpawnsPerHour;
    if ((recent?.n ?? 0) >= cap)
      return fail(
        `You've spawned ${cap} agents in the last hour; ${askFor(spawner)} if you need more.`,
      );
    const grants = await db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        hostPath: schema.projects.hostPath,
      })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(eq(schema.agentProjectGrants.agentId, spawner.id));
    let deny: ReturnType<typeof readDenyRules>;
    try {
      const file = path.join(
        templateCopyDir(this.d.config.factoryHome, spawner.slug),
        "settings.json",
      );
      deny = readDenyRules(JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>);
    } catch (err) {
      this.d.log.warn({ err, agent: spawner.slug }, "reading the spawner's template copy failed");
      return fail(`Your template copy can't be read; ${askFor(spawner)} to re-sync you.`);
    }
    if (!spawner.credentialId) return fail(CANT_SPAWN);
    const inherited = inheritFrom(
      {
        runtime: spawner.runtime,
        permissionMode: spawner.config.permissionMode,
        credentialId: spawner.credentialId,
        grants,
        secrets: spawner.config.secrets,
        deny,
      },
      tpl.config,
      readDenyRules(tpl.tplSettings),
      { localRuntimeAllowed: localRuntimeAllowed(this.d.config) },
    );
    if (!inherited.ok) return fail(inherited.refusal);
    return { ok: true, inherited };
  }

  /** S4's materialize under the workspace lock. `folder_exists` is a collision; any other failure removes the folder. */
  private async materialize(
    slug: string,
    template: string,
    description: string,
    tpl: Template,
    caller: AgentRow,
    inherited: Granted,
  ): Promise<"ok" | "taken" | Refused> {
    const { workspace } = this.d;
    try {
      await workspace.lock.run(slug, () =>
        workspace.materialize(slug, slug, tpl, {
          slug,
          displayName: displayName(tpl, slug, template),
          description,
          template,
          config: tpl.config,
          manager: { slug: caller.slug, displayName: caller.displayName },
          grants: inherited.grants.map((g) => ({ name: g.name, hostPath: g.hostPath })),
        }),
      );
      return "ok";
    } catch (err) {
      // folder_exists: the folder isn't ours (a crash's leftover or a human's); never remove it.
      if (err instanceof FieldError && err.code === "folder_exists") return "taken";
      await this.discard(slug);
      if (
        err instanceof PluginInstallError ||
        err instanceof WorkspaceError ||
        err instanceof FieldError
      )
        return fail(err.message);
      this.d.log.error({ err, agent: slug }, "materializing a spawned agent failed");
      return fail(`Setting up @${slug} failed; ${askFor(caller)} to check the factory log.`);
    }
  }

  /** §5.2 step 4: one transaction under the spawner's row lock; a failed re-check removes the folder. */
  private async insert(
    caller: AgentRow,
    slug: string,
    template: string,
    description: string,
    prompt: string,
    tpl: Template,
    toolUseId: string | null,
  ): Promise<SpawnResult | "taken"> {
    const { db, store, router } = this.d;
    const id = randomUUID();
    const at = new Date(this.now());
    type Done = {
      ok: true;
      child: AgentRow;
      brief: PendingRow;
      peers: PendingRow[];
      inherited: Granted;
    };
    let out: Done | Refused | "taken";
    try {
      out = await db.transaction(async (tx): Promise<Done | Refused | "taken"> => {
        // Lock order (§5.7): the spawner's row first, FOR NO KEY UPDATE (never FOR UPDATE), then message rows.
        const [spawner] = await tx
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, caller.id))
          .for("no key update");
        if (this.d.closing()) return fail(SHUTTING_DOWN);
        if (!spawner || !maySpawn(spawner)) return fail(CANT_SPAWN);
        if (!spawner.config.canSpawn.includes(template))
          return fail(`You can't spawn template ${template}.`);
        // Re-read the credential and grants under the lock (an update during materialize must not be missed).
        const c = await this.check(spawner, tpl, tx);
        if (!c.ok) return c;
        // Claim only once nothing can refuse any more: a refusal returns and commits, which would orphan the claim.
        if (!(await claimHandle(tx, slug, "agent"))) return "taken";
        const [child] = await tx
          .insert(schema.agents)
          .values({
            id,
            slug,
            displayName: displayName(tpl, slug, template),
            description,
            template,
            config: tpl.config,
            runtime: tpl.config.runtime,
            kind: "ephemeral",
            reportsTo: spawner.id,
            credentialId: c.inherited.credentialId,
            lastActivityAt: at,
            createdAt: at,
          })
          .returning();
        if (!child) throw new Error("inserting the spawned agent returned no row");
        if (c.inherited.grants.length)
          await tx
            .insert(schema.agentProjectGrants)
            .values(c.inherited.grants.map((g) => ({ agentId: id, projectId: g.id })));
        const brief = await store.createMessage(
          {
            from: { agentId: spawner.id },
            toAgentId: id,
            recipients: [`@${slug}`],
            body: prompt,
            urgent: false,
            fromToolUseId: toolUseId,
          },
          tx,
        );
        await store.append(id, null, { type: "spawned", by: spawner.slug, template }, tx);
        const peers = await router.persistPeerEvents(
          tx,
          id,
          { kind: "spawned" },
          { managerId: null, peerIds: [] },
          { excludeManager: true },
        );
        return { ok: true, child, brief, peers, inherited: c.inherited };
      });
    } catch (err) {
      await this.discard(slug);
      // Lost the agents.slug unique index to a concurrent claimer that committed first.
      if (isSlugUnique(err)) return "taken";
      this.d.log.error({ err, agent: slug }, "inserting a spawned agent failed");
      return fail(`Setting up @${slug} failed; ${askFor(caller)} to check the factory log.`);
    }
    if (out === "taken") {
      // The folder is this spawn's own (folder_exists refused a foreign one upstream), so discarding is safe.
      await this.discard(slug);
      return out;
    }
    if (!out.ok) {
      await this.discard(slug);
      return out;
    }
    // §5.2 step 5: the status before the hand-off; both hand-offs are enqueued after boot, never awaited.
    const status = await router.handOffBrief(out.brief, out.child);
    router.handOffHeldRows(out.peers);
    const note = droppedNote(out.inherited.dropped);
    return { ok: true, slug, agentId: id, status, ...(note ? { note } : {}) };
  }

  /** Best effort: the folder was made by this spawn's materialize. */
  private async discard(slug: string): Promise<void> {
    try {
      await this.d.workspace.lock.run(slug, () => this.d.workspace.discard(slug));
    } catch (err) {
      this.d.log.error({ err, agent: slug }, "removing a refused spawn's folder failed");
    }
  }
}

const displayName = (tpl: Template, slug: string, template: string) =>
  `${tpl.config.displayName} · ${slug.slice(template.length + 1)}`;
