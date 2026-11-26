import { lstat } from "node:fs/promises";
import path from "node:path";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import {
  type Actor,
  type AgentOverlay,
  type AgentSummary,
  actorBy,
  actorTag,
  agentOverlaySchema,
  agentPolicyIssues,
  type ConfigDoc,
  type CreateAgentBody,
  handleSchema,
  LOCAL_RUNTIME_REFUSAL,
  nameSchema,
  type PatchAgentBody,
  type PutAgentConfigResponse,
  type ReportsTo,
  type ResolvedValue,
  touchesLocalRuntime,
  treeOrder,
} from "@open-factory/shared";
import { agentTagOf, unknownRefError } from "@open-factory/shared/tags";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ApiError, FieldError } from "../errors.ts";
import { FIELD_MSG } from "../field-messages.ts";
import { liveAgent } from "../messaging/neighborhood.ts";
import type { PeerChange, Router } from "../messaging/router.ts";
import { resolveAgentArg, resolveArg } from "../principals/principal-args.ts";
import {
  agentRowByRef,
  createPrincipal,
  HandleTakenError,
  type Principal,
  principalById,
  principalsByHandles,
  principalsByIds,
  tagOfPrincipal,
} from "../principals/principal-store.ts";
import { resolveField } from "../principals/principal-text.ts";
import type { ContainerManager } from "../runtime/docker/containers.ts";
import { WORKSPACE_GRACE_MS } from "../spawning/lifecycle.ts";
import { avatarStat } from "../templates/avatar.ts";
import type { TemplateIndex } from "../templates/template-index.ts";
import { overlayIssues, overlaySchemaIssues } from "../templates/validate.ts";
import { WorkspaceError } from "../workspace/links.ts";
import type { KeyedMutex } from "../workspace/lock.ts";
import type { MaterializeCheck, Workspace } from "../workspace/workspace.ts";
import type { RuntimeLog } from "./agent-runtime.ts";
import type { ConfigChanges } from "./config-changes.ts";
import type { OverlayPlan } from "./config-service.ts";
import { OrgRefusedError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventStore, Exec, Tx } from "./event-store.ts";
import type { PolicyInputs } from "./policy-inputs.ts";
import type { AgentRuntimes } from "./runtimes.ts";

/** What `planUpdate` validated: `write` runs in the caller's transaction (which holds the row lock), `after` once it commits. */
export type UpdatePlan = {
  row: AgentRow;
  write(tx: Tx): Promise<void>;
  after(): Promise<AgentSummary>;
};

/** A subject with no neighbours to leave behind (a join reads the neighbourhood after the change). */
const noPeers = { managerId: null, peerIds: [] };

/** The principals a set of rows name as their manager or terminator, by id. */
type Managers = Map<string, Principal>;

/** The row's manager as the DTO says it (a spawned agent's is its spawner). */
function reportsToOf(r: AgentRow, m: Managers): ReportsTo {
  const p = m.get(r.reportsTo);
  // The FK makes a miss impossible.
  if (!p) throw new Error(`agent ${r.id} reports to unknown principal ${r.reportsTo}`);
  return { kind: p.kind, ref: p.ref, handle: p.handle };
}

/** The agent's own principal (its ref and handle); the FK makes a miss impossible. */
function principalOf(r: AgentRow, m: Managers): Principal {
  const p = m.get(r.id);
  if (!p) throw new Error(`agent ${r.id} has no principal`);
  return p;
}

/** A resolved manager: an active persistent agent, or an enabled user. */
type Manager =
  | { kind: "agent"; row: AgentRow; ref: string; handle: string }
  | { kind: "human"; id: string; ref: string; handle: string; name: string };

const handleTaken = () => new FieldError("handle", FIELD_MSG.handleTaken, "handle_taken");

/** A materialize failure as the API's: the template's folders didn't pass the workspace checks. */
function materializeFailure(err: unknown, actor: Actor): unknown {
  if (!(err instanceof WorkspaceError)) return err;
  // The workspace messages name host paths; no org tool result may (spec AC 6), so an agent gets a path-free sentence.
  return new ApiError(
    409,
    "template_invalid",
    actor.kind === "agent"
      ? "The template's or a project's folder can't be used to set up this agent; ask a human."
      : err.message,
  );
}

/** S7 §9.3: a spawner's live spawned agents block its archive; terminate them, don't move them. */
function spawnedMessage(spawner: string, handles: string[]): string {
  return `@${spawner} has live spawned agents: ${handles.map((h) => `@${h}`).join(", ")}. Terminate them first.`;
}

function reportsMessage(handles: string[]): string {
  const tags = handles.map((h) => `@${h}`);
  const who =
    tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}`;
  return `${who} ${tags.length === 1 ? "reports" : "report"} to this agent. Change their manager first.`;
}

/** The ended list's cap (S7 §14): the newest 200; one more row is read to know whether older ones exist. */
export const ENDED_LIST_LIMIT = 200;

/**
 * The ended agents (archived or terminated), newest end first. Its WHERE and ORDER BY are `agents_ended_idx`'s
 * predicate and expression, so it is served by that index whatever the spawn history.
 */
export function endedAgentsQuery(db: Exec) {
  const endedAt = sql`coalesce(${schema.agents.terminatedAt}, ${schema.agents.archivedAt})`;
  return db
    .select()
    .from(schema.agents)
    .where(or(isNotNull(schema.agents.terminatedAt), isNotNull(schema.agents.archivedAt)))
    .orderBy(desc(endedAt))
    .limit(ENDED_LIST_LIMIT + 1);
}

/** S7 §14: a terminated agent's fields; the grace end only while its workspace still exists. */
function terminationFields(r: AgentRow, m: Managers) {
  if (!r.terminatedAt) return {};
  const by = r.terminatedBy ? m.get(r.terminatedBy) : undefined;
  return {
    terminatedAt: r.terminatedAt.toISOString(),
    terminatedBy: by ? { ref: by.ref, handle: by.handle } : null,
    workspacePinned: r.workspacePinned,
    ...(r.workspaceDeletedAt
      ? { workspaceDeletedAt: r.workspaceDeletedAt.toISOString() }
      : {
          workspaceGraceEndsAt: new Date(
            r.terminatedAt.getTime() + WORKSPACE_GRACE_MS,
          ).toISOString(),
        }),
  };
}

export class AgentService {
  constructor(
    private readonly d: {
      db: Db;
      templates: TemplateIndex;
      workspace: Workspace;
      lock: KeyedMutex;
      runtimes: AgentRuntimes;
      log: RuntimeLog;
      /** The one ContainerManager: a running container counts as a process for the persona-reset gate (spec §11.4). */
      containers?: Pick<ContainerManager, "isRunning">;
      /** Peer events (spec §10.2): the router snapshots the neighborhood and writes the rows. */
      router: Pick<Router, "peerEvents" | "snapshot">;
      /** The registry, catalog and template-runtime reads the agent policy and the local-runtime rule need. */
      policy: PolicyInputs;
      /** Reset persona writes its `config_changed` event here when the agent has no loaded runtime. */
      store: Pick<EventStore, "append">;
      bus: Pick<EventBus, "publishAll">;
      /** I2 §7.2: an overlay save writes its event and notice and schedules the restart check here. */
      configChanges: Pick<ConfigChanges, "overlaySaved">;
      /** The factory's local-runtime gate (`config.allowLocalRuntime`), read live. */
      localRuntimeAllowed: () => boolean;
      /** S9 §10.1: unarchive recomputes every schedule targeting the agent in its transaction (no catch-up). */
      scheduling?: {
        recomputeForTarget(tx: Tx, agentId: string): Promise<void>;
        changed(): void;
      };
    },
  ) {}

  /** The rows are already committed: a failure here is logged and never fails the caller's request. */
  private async peerEvents(
    id: string,
    change: PeerChange,
    before: { managerId: string | null; peerIds: string[] },
  ): Promise<void> {
    try {
      await this.d.router.peerEvents(id, change, before);
    } catch (err) {
      this.d.log.error({ err, agent: id }, "Writing peer events failed");
    }
  }

  /** The `by` of a peer event (spec I7 §8.2): an agent actor's tag; a human's act is visible in the UI. */
  private byOf(actor: Actor): { by?: string } {
    return actor.kind === "agent" ? { by: actorTag(actor) } : {};
  }

  /** I7 §8.3: the human bus hears of an agent actor's create, archive or unarchive, after the commit. */
  private orgAction(
    actor: Actor,
    action: "agent_created" | "agent_archived" | "agent_unarchived",
    subject: string,
  ) {
    if (actor.kind === "agent")
      this.d.bus.publishAll({ type: "org_action", action, by: actorBy(actor), subject });
  }

  private snapshot(id: string, tx: Exec = this.d.db) {
    return this.d.router.snapshot(tx, id);
  }

  /**
   * `exclude`: the live agents (neither archived nor terminated), in tree order. `only`: the ended ones (archived or
   * terminated), flat, newest end first, at most `ENDED_LIST_LIMIT` (`more` says whether older ones exist), so the cost
   * stays flat as spawn history grows (S7 §14).
   */
  async list(ended: "exclude" | "only"): Promise<{ agents: AgentSummary[]; more: boolean }> {
    if (ended === "exclude") return { agents: await this.listLive(), more: false };
    const rows = await endedAgentsQuery(this.d.db);
    const more = rows.length > ENDED_LIST_LIMIT;
    const shown = rows.slice(0, ENDED_LIST_LIMIT);
    return { agents: await this.summarize(shown.map((row) => ({ row, depth: 0 }))), more };
  }

  private async listLive(): Promise<AgentSummary[]> {
    const rows = await this.d.db
      .select()
      .from(schema.agents)
      .where(and(isNull(schema.agents.archivedAt), isNull(schema.agents.terminatedAt)));
    const managers = await this.managersOf(rows);
    const order = treeOrder(
      rows.map((r) => ({
        ref: principalOf(r, managers).ref,
        handle: principalOf(r, managers).handle,
        displayName: r.displayName,
        reportsTo: reportsToOf(r, managers),
      })),
    );
    const byRef = new Map(rows.map((r) => [principalOf(r, managers).ref, r]));
    return this.summarize(
      order.map(({ ref, depth }) => {
        const row = byRef.get(ref);
        if (!row) throw new Error("tree order returned an unknown ref");
        return { row, depth };
      }),
      managers,
    );
  }

  /** The principals of `rows`, their managers and their terminators, read for those principals only. */
  private async managersOf(rows: AgentRow[]): Promise<Managers> {
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.id);
      ids.add(r.reportsTo);
      if (r.terminatedBy) ids.add(r.terminatedBy);
    }
    return principalsByIds(this.d.db, [...ids]);
  }

  /** I9 §4.6: each shown agent's model and effort, from its overlay, else the template's last valid doc, else neither. */
  private async resolvedConfig(
    rows: AgentRow[],
  ): Promise<Map<string, { model: ResolvedValue; effort: ResolvedValue }>> {
    const docs = new Map(
      await Promise.all(
        [...new Set(rows.map((r) => r.template))].map(
          async (t) => [t, await this.d.templates.lastValid(t)] as const,
        ),
      ),
    );
    const pick = (own: unknown, base: unknown): ResolvedValue =>
      typeof own === "string" && own
        ? { value: own, source: "agent" }
        : typeof base === "string" && base
          ? { value: base, source: "template" }
          : { value: null, source: null };
    return new Map(
      rows.map((r) => {
        const own = agentOverlaySchema.safeParse(this.overlayOf(r));
        const mine = own.success ? own.data.template : undefined;
        const theirs = docs.get(r.template)?.template;
        return [
          r.id,
          {
            model: pick(mine?.model, theirs?.model),
            effort: pick(mine?.effort, theirs?.effort),
          },
        ];
      }),
    );
  }

  /**
   * The summaries of the shown rows only: their managers, their live reports (S7 §9.2: an ended agent has none to
   * count) and their grants are each read for those rows, never for every agent ever spawned.
   */
  private async summarize(
    shown: { row: AgentRow; depth: number }[],
    knownManagers?: Managers,
  ): Promise<AgentSummary[]> {
    const { db } = this.d;
    if (shown.length === 0) return [];
    const rows = shown.map((s) => s.row);
    const managers = knownManagers ?? (await this.managersOf(rows));
    const resolved = await this.resolvedConfig(rows);
    const liveIds = rows.filter((r) => !r.archivedAt && !r.terminatedAt).map((r) => r.id);
    const reportCount = new Map<string, number>();
    if (liveIds.length > 0)
      for (const r of await db
        .select({ managerId: schema.agents.reportsTo, n: count() })
        .from(schema.agents)
        .where(and(inArray(schema.agents.reportsTo, liveIds), liveAgent))
        .groupBy(schema.agents.reportsTo))
        if (r.managerId) reportCount.set(r.managerId, r.n);
    const openTasks = new Map<string, number>();
    for (const r of await db
      .select({ agentId: schema.tasks.assigneeAgentId, n: count() })
      .from(schema.tasks)
      .where(
        and(
          inArray(
            schema.tasks.assigneeAgentId,
            rows.map((x) => x.id),
          ),
          inArray(schema.tasks.status, ["open", "in_progress"]),
        ),
      )
      .groupBy(schema.tasks.assigneeAgentId))
      if (r.agentId) openTasks.set(r.agentId, r.n);
    // S9: schedules targeting each shown agent that are neither deleted nor done (the strip's link).
    const scheduleCount = new Map<string, number>();
    for (const r of await db
      .select({ agentId: schema.schedules.targetAgentId, n: count() })
      .from(schema.schedules)
      .where(
        and(
          inArray(
            schema.schedules.targetAgentId,
            rows.map((x) => x.id),
          ),
          isNull(schema.schedules.deletedAt),
          sql`not (${schema.schedules.runAt} is not null and ${schema.schedules.nextRunAt} is null)`,
        ),
      )
      .groupBy(schema.schedules.targetAgentId))
      scheduleCount.set(r.agentId, r.n);
    const credName = new Map(
      (
        await db
          .select({ id: schema.credentials.id, name: schema.credentials.name })
          .from(schema.credentials)
      ).map((c) => [c.id, c.name]),
    );
    const grants = await db
      .select({ agentId: schema.agentProjectGrants.agentId, name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(
        inArray(
          schema.agentProjectGrants.agentId,
          rows.map((r) => r.id),
        ),
      );
    const projectsOf = new Map<string, string[]>();
    for (const g of grants)
      projectsOf.set(g.agentId, [...(projectsOf.get(g.agentId) ?? []), g.name]);
    // U2 §15.3: one avatar check per distinct template, run live from disk (never cached across responses).
    const avatarOf = new Map(
      await Promise.all(
        [...new Set(rows.map((r) => r.template))].map(
          async (t) =>
            [
              t,
              nameSchema.safeParse(t).success
                ? (await avatarStat(path.join(this.d.templates.dir, t), this.d.templates.dir))
                    .version
                : null,
            ] as const,
        ),
      ),
    );

    return Promise.all(
      shown.map(async ({ row: r, depth }) => ({
        ref: principalOf(r, managers).ref,
        handle: principalOf(r, managers).handle,
        displayName: r.displayName,
        description: r.description,
        kind: r.kind as "persistent" | "ephemeral",
        template: r.template,
        runtime: r.runtime,
        reportsTo: reportsToOf(r, managers),
        model: resolved.get(r.id)?.model ?? { value: null, source: null },
        effort: resolved.get(r.id)?.effort ?? { value: null, source: null },
        reports: reportCount.get(r.id) ?? 0,
        openTasks: openTasks.get(r.id) ?? 0,
        scheduleCount: scheduleCount.get(r.id) ?? 0,
        avatarVersion: avatarOf.get(r.template) ?? null,
        color: r.color,
        manageOrg: r.manageOrg,
        credential: credName.get(r.credentialId ?? "") ?? null,
        projects: (projectsOf.get(r.id) ?? []).sort(),
        depth,
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        ...terminationFields(r, managers),
        ...(await this.d.runtimes.liveFields(r.id, r)),
      })),
    );
  }

  /** A live agent's summary comes from the live tree (its depth); an ended one's is read alone. */
  async summary(ref: string): Promise<AgentSummary> {
    const row = await agentRowByRef(this.d.db, ref);
    if (!row) throw this.notFound();
    const found =
      row.archivedAt || row.terminatedAt
        ? (await this.summarize([{ row, depth: 0 }]))[0]
        : (await this.listLive()).find((a) => a.ref === ref);
    if (!found) throw this.notFound();
    return found;
  }

  /** S7 §9.3: a spawned agent follows its spawner and its template; it is terminated, never edited. */
  private assertPersistent(row: AgentRow) {
    if (row.kind === "ephemeral")
      throw new ApiError(
        409,
        "ephemeral_agent",
        "Spawned agents can't be edited; terminate it instead.",
      );
  }

  /** S7 §5.7: the spawner's row first, `FOR NO KEY UPDATE` (never `FOR UPDATE`), before any child row. */
  private async lockAgent(tx: Tx, id: string) {
    const [r] = await tx
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .for("no key update");
    return r;
  }

  /**
   * S7 §6.3: the one owner of live children's credential and grants. Call inside every transaction that changes a
   * spawner's credential or grants, after the spawner's row is written: it rewrites each live child's `credential_id`
   * to the spawner's and its grants to the spawner's (a child works on its spawner's projects, whatever its template
   * lists). Locks the spawner's row, then the children's (§5.7). Returns the changed children's ids; the caller refreshes and restarts them after the commit.
   */
  async syncChildren(tx: Tx, spawnerId: string): Promise<string[]> {
    const spawner = await this.lockAgent(tx, spawnerId);
    if (!spawner) return [];
    const held = await tx
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(eq(schema.agentProjectGrants.agentId, spawnerId));
    const kids = await tx
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.reportsTo, spawnerId),
          eq(schema.agents.kind, "ephemeral"),
          isNull(schema.agents.terminatedAt),
        ),
      )
      .orderBy(asc(schema.agents.id))
      .for("no key update");
    const changed: string[] = [];
    for (const k of kids) {
      const want = held;
      const have = (
        await tx
          .select({ id: schema.agentProjectGrants.projectId })
          .from(schema.agentProjectGrants)
          .where(eq(schema.agentProjectGrants.agentId, k.id))
      )
        .map((r) => r.id)
        .sort();
      const sameGrants =
        have.join("\0") ===
        want
          .map((p) => p.id)
          .sort()
          .join("\0");
      if (k.credentialId === spawner.credentialId && sameGrants) continue;
      if (k.credentialId !== spawner.credentialId)
        await tx
          .update(schema.agents)
          .set({ credentialId: spawner.credentialId })
          .where(eq(schema.agents.id, k.id));
      if (!sameGrants) await this.replaceGrants(tx, k.id, want);
      changed.push(k.id);
    }
    return changed;
  }

  /** After the commit: the Supervisor reads the credential from the loaded row, so reload, then apply (§6.3). */
  private async applyToChildren(ids: string[]) {
    for (const id of ids) {
      await this.d.runtimes.refresh(id);
      await this.d.runtimes.requestRestart(id);
    }
  }

  private notFound() {
    return new ApiError(404, "agent_not_found", "No agent at this ref");
  }

  private async rowByRef(ref: string): Promise<AgentRow> {
    const row = await agentRowByRef(this.d.db, ref);
    if (!row) throw this.notFound();
    return row;
  }

  private async credentialId(name: string): Promise<string> {
    const [c] = await this.d.db
      .select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(eq(schema.credentials.name, name));
    if (!c) throw new FieldError("credential", FIELD_MSG.chooseCredential);
    return c.id;
  }

  /** In the write transaction: a human manager is still enabled (FOR SHARE serializes with a disable). */
  private async assertUserEnabled(tx: Tx, manager: Manager | undefined) {
    if (manager?.kind !== "human") return;
    const rows = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, manager.id), isNull(schema.users.disabledAt)))
      .for("share");
    if (!rows.length) throw new FieldError("reportsTo", FIELD_MSG.chooseManager);
  }

  /**
   * The agent an org tool's argument names (a tag, a ref or a handle), for the services that take refs, with the
   * plain-tag warning when it was a plain handle. A ref nobody holds is refused with the fix-it sentence; a name that
   * isn't an agent is a 404.
   */
  async agentOf(
    raw: string,
  ): Promise<{ ref: string; handle: string; tag: string; warning?: string }> {
    const r = await resolveAgentArg(this.d.db, raw);
    if (r.kind === "unknown_ref") throw new OrgRefusedError(unknownRefError(r.ref));
    if (r.kind === "not_agent")
      throw new ApiError(404, "agent_not_found", `No agent named ${r.name}`);
    return {
      ref: r.ref,
      handle: r.handle,
      tag: agentTagOf({ ref: r.ref, handle: r.handle }),
      ...(r.warning ? { warning: r.warning } : {}),
    };
  }

  /** `agentOf` for a manager, who may be an agent or a person: an agent writer's unknown ref gets the fix-it sentence. */
  async managerHandleOf(raw: string): Promise<{ handle: string; warning?: string }> {
    const r = await resolveArg(this.d.db, raw);
    if (r.kind === "unknown_ref") throw new OrgRefusedError(unknownRefError(r.ref));
    if (r.kind === "principal")
      return { handle: r.p.handle, ...(r.warning ? { warning: r.warning } : {}) };
    return { handle: raw.trim().replace(/^@/, "") };
  }

  private async resolveManager(raw: string): Promise<Manager> {
    const refuse = () => new FieldError("reportsTo", FIELD_MSG.chooseManager);
    const r = await resolveArg(this.d.db, raw);
    if (r.kind !== "principal") throw refuse();
    const { p } = r;
    if (p.kind === "human") {
      const [u] = await this.d.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(and(eq(schema.users.id, p.id), isNull(schema.users.disabledAt)));
      if (!u) throw refuse();
      return { kind: "human", ...u, ref: p.ref, handle: p.handle };
    }
    const [m] = await this.d.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.id, p.id),
          eq(schema.agents.kind, "persistent"),
          isNull(schema.agents.archivedAt),
          isNull(schema.agents.terminatedAt),
        ),
      );
    // S7 §9.3: no spawned managers, so reports never hang under an agent that gets terminated.
    if (!m) throw refuse();
    return { kind: "agent", row: m, ref: p.ref, handle: p.handle };
  }

  /** Registered projects by name, in the order given; the first unknown name is a field error. */
  private async projectRows(
    given: string[],
  ): Promise<{ id: string; name: string; hostPath: string }[]> {
    // A repeated name is one grant: the grant table's primary key would reject the duplicate.
    const names = [...new Set(given)];
    const found = names.length
      ? await this.d.db
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            hostPath: schema.projects.hostPath,
          })
          .from(schema.projects)
          .where(inArray(schema.projects.name, names))
      : [];
    const byName = new Map(found.map((p) => [p.name, p]));
    return names.map((n) => {
      const p = byName.get(n);
      if (!p) throw new FieldError("projects", FIELD_MSG.projectRemoved);
      return p;
    });
  }

  /**
   * Switching runtime moves an agent in or out of the sandbox, so only a human does it, explicitly. Local needs the
   * factory's gate, and a template in Bypass mode keeps its agents in Docker (the same rule as `validate.ts`).
   */
  private async assertRuntimeSwitch(row: AgentRow, to: "docker" | "local", actor: Actor) {
    if (actor.kind === "agent")
      throw new OrgRefusedError("Only a human can change an agent's runtime.");
    if (to !== "local") return;
    if (!this.d.localRuntimeAllowed()) throw new FieldError("runtime", FIELD_MSG.localDisabled);
    const tpl = await this.d.templates.loadValid(row.template);
    if (tpl.config.permissionMode === "bypass")
      throw new FieldError("runtime", FIELD_MSG.bypassNeedsDocker);
  }

  /** Rule 8 for an agent actor: it never reaches a local runtime. A human is never judged by it. */
  private assertNotLocal(actor: Actor, touched: Parameters<typeof touchesLocalRuntime>[0]) {
    if (actor.kind === "agent" && touchesLocalRuntime(touched))
      throw new OrgRefusedError(LOCAL_RUNTIME_REFUSAL);
  }

  /** Rule 8 for create: the template and every can_spawn name. A malformed can_spawn is left for the overlay check to report. */
  private async assertCreateNotLocal(
    b: CreateAgentBody & { config?: AgentOverlay },
    actor: Actor,
    parsedTemplateRuntime?: string,
  ) {
    const raw: unknown = b.config?.template?.can_spawn;
    const spawns = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
    // The template's own runtime comes from the parse (`loadValid`, then this re-check under the lock): a missing or
    // invalid template gets the human's refusal there, not the local-runtime sentence.
    this.assertNotLocal(actor, {
      templateRuntime: parsedTemplateRuntime,
      canSpawnRuntimes: await this.d.policy.templateRuntimes(spawns),
    });
  }

  async create(
    b: CreateAgentBody & { config?: AgentOverlay },
    actor: Actor,
    warnings: string[] = [],
  ): Promise<AgentSummary> {
    const handleOk = handleSchema.safeParse(b.handle);
    if (!handleOk.success)
      throw new FieldError("handle", handleOk.error.issues[0]?.message ?? FIELD_MSG.handleInvalid);
    if (b.manageOrg !== undefined && actor.kind === "agent")
      throw new OrgRefusedError("Only a human can grant manage_org.");
    if (actor.kind === "agent") await this.assertCreateNotLocal(b, actor);
    return this.d.lock.run(`create:${b.handle}`, () => this.createLocked(b, actor, warnings));
  }

  private async createLocked(
    b: CreateAgentBody & { config?: AgentOverlay },
    actor: Actor,
    warnings: string[],
  ): Promise<AgentSummary> {
    const { db, workspace } = this.d;
    // The cheap pre-read before materialising; the principal insert in the transaction is the guarantee (spec §4.1).
    if ((await principalsByHandles(db, [b.handle])).size) throw handleTaken();
    // Spec §4.3: the description's tags are stored as `<@ref>`; an unknown ref refuses the create.
    b = {
      ...b,
      description: (await resolveField(db, b.description, actor.kind, "description", warnings))
        .text,
    };
    const tpl = await this.d.templates.loadValid(b.template);
    // Re-check under the lock against the template as just parsed: last_valid may have moved since the pre-check.
    if (actor.kind === "agent") await this.assertCreateNotLocal(b, actor, tpl.config.runtime);
    const credentialId = await this.credentialId(b.credential);
    const manager = await this.resolveManager(b.reportsTo);
    const projects = await this.projectRows(b.projects ?? tpl.config.projects);
    const config = b.config ? await this.checkedOverlay(b.config, tpl, actor) : {};

    const prep: MaterializeCheck = {
      handle: b.handle,
      displayName: b.displayName,
      description: b.description,
      template: b.template,
      config: tpl.config,
      manager:
        manager.kind === "agent"
          ? {
              kind: "agent",
              ref: manager.ref,
              handle: manager.handle,
              displayName: manager.row.displayName,
            }
          : { kind: "human", ref: manager.ref, handle: manager.handle, name: manager.name },
      grants: projects.map((p) => ({ name: p.name, hostPath: p.hostPath })),
    };
    // Spec §4.4: the principal first (it settles the handle and gives the ref the folder is named by), then the
    // folder under the ref's lock, then the rows. A failure after the folder removes it; the rollback removes the
    // principal.
    const made: { ref?: string; stage: "principal" | "folder" | "rows" } = { stage: "principal" };
    let id: string;
    try {
      id = await db.transaction(async (tx) => {
        const principal = await createPrincipal(tx, "agent", b.handle);
        const { id } = principal;
        made.ref = principal.ref;
        made.stage = "folder";
        await workspace.lock.run(principal.ref, () =>
          workspace.materialize(principal.ref, tpl, prep),
        );
        made.stage = "rows";
        await this.assertUserEnabled(tx, manager);
        await tx.insert(schema.agents).values({
          id,
          displayName: b.displayName,
          description: b.description,
          descriptionBy: actor.kind === "agent" ? actor.id : null,
          template: b.template,
          // I2 §5.1: the overlay starts empty (the agent runs the live template) unless the creator gave one.
          config,
          runtime: tpl.config.runtime,
          reportsTo: manager.kind === "agent" ? manager.row.id : manager.id,
          credentialId,
          manageOrg: b.manageOrg ?? false,
        });
        if (projects.length)
          await tx
            .insert(schema.agentProjectGrants)
            .values(projects.map((p) => ({ agentId: id, projectId: p.id })));
        return id;
      });
    } catch (err) {
      if (err instanceof HandleTakenError) throw handleTaken();
      // folder_exists means the folder isn't ours: leave it alone.
      const foreign = err instanceof FieldError && err.code === "folder_exists";
      if (made.ref && made.stage !== "principal" && !foreign)
        await workspace.discard(made.ref).catch(() => {});
      throw made.stage === "folder" ? materializeFailure(err, actor) : err;
    }
    await this.peerEvents(id, { kind: "joined", ...this.byOf(actor) }, noPeers);
    const ref = made.ref;
    if (!ref) throw new Error("create finished without a principal");
    this.orgAction(actor, "agent_created", ref);
    return this.summary(ref);
  }

  /**
   * A new agent's overlay, validated before anything is materialised: the schema, then the merged doc's new issues (as
   * `configIssues` would, with the template's runtime standing in for the row that doesn't exist yet), then for an agent
   * actor the policy with nothing before it. Any error refuses the whole create.
   */
  private async checkedOverlay(
    config: AgentOverlay,
    tpl: { doc: ConfigDoc; dir: string; config: { runtime: "local" | "docker" } },
    actor: Actor,
  ): Promise<AgentOverlay> {
    const parsed = agentOverlaySchema.safeParse(config);
    const issues = parsed.success
      ? [
          ...(await overlayIssues(tpl.doc, parsed.data, {
            ...(await this.d.templates.context()),
            templateDir: tpl.dir,
            agentRuntimes: [tpl.config.runtime],
          })),
          ...(actor.kind === "agent"
            ? agentPolicyIssues({ target: "overlay", before: {}, after: parsed.data })
            : []),
        ]
      : overlaySchemaIssues(config);
    if (!parsed.success || issues.some((i) => i.severity === "error"))
      throw new ApiError(400, "invalid_config", "The configuration has errors.", { issues });
    return parsed.data;
  }

  async update(
    ref: string,
    b: PatchAgentBody,
    actor: Actor,
    warnings: string[] = [],
  ): Promise<AgentSummary> {
    const plan = await this.planUpdate(ref, b, actor, warnings);
    await this.d.db.transaction(async (tx) => {
      await this.lockAgent(tx, plan.row.id);
      await plan.write(tx);
    });
    return plan.after();
  }

  /**
   * I7 §7.5: an identity patch and an overlay save in ONE transaction, so a refusal of either writes nothing. `c` is
   * `ConfigService.planOverlay`'s plan (validated first, the stale version already checked); the transaction locks the
   * row once, lets the overlay re-check its version against the locked row, then writes both. The events and restart
   * requests of both run after the commit.
   */
  async updateWithOverlay(
    ref: string,
    b: PatchAgentBody,
    c: OverlayPlan | undefined,
    actor: Actor,
    warnings: string[] = [],
  ): Promise<{ agent: AgentSummary; config?: PutAgentConfigResponse }> {
    const u = await this.planUpdate(ref, b, actor, warnings);
    await this.d.db.transaction(async (tx) => {
      const locked = await this.lockAgent(tx, u.row.id);
      if (!locked) throw this.notFound();
      await c?.write(tx, locked);
      await u.write(tx);
    });
    // The manager notice goes to the manager as committed, which the identity half may have just changed.
    // (`after` closes over this same row object.)
    if (c) c.row.reportsTo = (await this.rowByRef(ref)).reportsTo;
    const config = await c?.after();
    return { agent: await u.after(), ...(config ? { config } : {}) };
  }

  /**
   * Validates a PATCH outside any transaction (disk and Library reads) and returns its writes: `write(tx)` runs in
   * the caller's transaction after it locked the row (it locks nothing itself), `after()` the refresh, peer events and
   * restarts once that commits.
   */
  async planUpdate(
    ref: string,
    b: PatchAgentBody,
    actor: Actor,
    warnings: string[] = [],
  ): Promise<UpdatePlan> {
    const { db, runtimes } = this.d;
    if (b.manageOrg !== undefined && actor.kind === "agent")
      throw new OrgRefusedError("Only a human can grant manage_org.");
    const row = await this.rowByRef(ref);
    this.assertPersistent(row);
    this.assertNotLocal(actor, { agentRuntime: row.runtime });
    const currentGrants = await this.grantNames(row.id);
    const changed = { feeds: false, text: false };
    let moved: { to: string } | undefined;
    let movedTo: Manager | undefined;
    const set: Partial<typeof schema.agents.$inferInsert> = {};

    if (b.displayName !== undefined && b.displayName !== row.displayName) {
      set.displayName = b.displayName;
      changed.text = true;
    }
    // Spec §4.3: the description's tags are stored as `<@ref>`; an unknown ref refuses the change.
    const description =
      b.description === undefined
        ? undefined
        : (await resolveField(db, b.description, actor.kind, "description", warnings)).text;
    if (description !== undefined && description !== row.description) {
      set.description = description;
      set.descriptionBy = actor.kind === "agent" ? actor.id : null;
      changed.text = true;
    }
    if (b.manageOrg !== undefined && b.manageOrg !== row.manageOrg) {
      set.manageOrg = b.manageOrg;
      changed.feeds = true;
    }
    if (b.runtime !== undefined && b.runtime !== row.runtime) {
      await this.assertRuntimeSwitch(row, b.runtime, actor);
      set.runtime = b.runtime;
      changed.feeds = true;
    }
    // Identity only: it never feeds the process, so it sets no `changed` flag and never restarts.
    if (b.color !== undefined && b.color !== row.color) set.color = b.color;
    if (b.credential !== undefined) {
      const id = await this.credentialId(b.credential);
      if (id !== row.credentialId) {
        set.credentialId = id;
        changed.feeds = true;
      }
    }
    if (b.reportsTo !== undefined) {
      const manager = await this.resolveManager(b.reportsTo);
      if (manager.kind === "agent") await this.assertNoCycle(row.id, manager.row);
      const managerId = manager.kind === "agent" ? manager.row.id : manager.id;
      if (managerId !== row.reportsTo) {
        set.reportsTo = managerId;
        moved = {
          to: await tagOfPrincipal(db, manager.kind === "agent" ? manager.row.id : manager.id),
        };
        movedTo = manager;
        changed.feeds = true;
      }
    }
    const before = moved ? await this.snapshot(row.id) : undefined;
    let newGrants: { id: string; name: string }[] | undefined;
    if (b.projects !== undefined) {
      newGrants = await this.projectRows(b.projects);
      const same =
        [...newGrants.map((p) => p.name)].sort().join("\0") ===
        [...currentGrants].sort().join("\0");
      if (!same) changed.feeds = true;
    }

    let children: string[] = [];
    return {
      row,
      write: async (tx) => {
        await this.assertUserEnabled(tx, movedTo);
        if (Object.keys(set).length)
          await tx.update(schema.agents).set(set).where(eq(schema.agents.id, row.id));
        if (newGrants) await this.replaceGrants(tx, row.id, newGrants);
        children = await this.syncChildren(tx, row.id);
      },
      after: async () => {
        await runtimes.refresh(row.id);
        await this.applyToChildren(children);
        if (moved && before)
          await this.peerEvents(
            row.id,
            { kind: "moved", to: moved.to, ...this.byOf(actor) },
            before,
          );
        // I7 §9.5: an agent that edits itself is woken by the restart it asked for.
        const self = actor.kind === "agent" && actor.id === row.id;
        if (changed.feeds || changed.text)
          await (self
            ? runtimes.requestRestart(row.id, { wake: true })
            : runtimes.requestRestart(row.id));
        if (changed.text) {
          const reports = await db
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(and(eq(schema.agents.reportsTo, row.id), liveAgent));
          for (const r of reports) await runtimes.requestRestart(r.id);
        }
        return this.summary(ref);
      },
    };
  }

  private async grantNames(agentId: string): Promise<string[]> {
    const rows = await this.d.db
      .select({ name: schema.projects.name })
      .from(schema.agentProjectGrants)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.agentProjectGrants.projectId))
      .where(eq(schema.agentProjectGrants.agentId, agentId));
    return rows.map((r) => r.name);
  }

  private async replaceGrants(tx: Tx, agentId: string, projects: { id: string }[]) {
    await tx
      .delete(schema.agentProjectGrants)
      .where(eq(schema.agentProjectGrants.agentId, agentId));
    if (projects.length)
      await tx
        .insert(schema.agentProjectGrants)
        .values(projects.map((p) => ({ agentId, projectId: p.id })));
  }

  /** Walks reportsTo upward from the new manager; reaching the agent itself is a cycle. */
  private async assertNoCycle(id: string, manager: AgentRow) {
    const seen = new Set<string>();
    let cur: AgentRow | undefined = manager;
    while (cur && !seen.has(cur.id)) {
      if (cur.id === id) throw new FieldError("reportsTo", FIELD_MSG.reportsCycle);
      seen.add(cur.id);
      if (!cur.reportsTo) return;
      const [next] = await this.d.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, cur.reportsTo));
      cur = next;
    }
  }

  private async handleOfId(agentId: string): Promise<string> {
    const p = await principalById(this.d.db, agentId);
    if (!p) throw new Error(`No principal ${agentId}`);
    return p.handle;
  }

  /** The ref its workdir, container and workspace lock are named by (spec §4.4). */
  private async refOf(agentId: string): Promise<string> {
    const p = await principalById(this.d.db, agentId);
    if (!p) throw new Error(`No principal ${agentId}`);
    return p.ref;
  }

  /** Fails closed: a Docker agent whose container state can't be read (Docker down) is treated as running. */
  private async containerRunning(row: AgentRow): Promise<boolean> {
    if (row.runtime !== "docker") return false;
    if (!this.d.containers) return true;
    try {
      return await this.d.containers.isRunning(row.id, await this.refOf(row.id));
    } catch (err) {
      this.d.log.warn(
        { err, agent: row.id },
        "couldn't check the container; staging the persona reset",
      );
      return true;
    }
  }

  /**
   * Reset persona (spec §9): the agent's AGENTS.md is replaced with the template's. Written at once when no process
   * (and for Docker no container) is running, else staged for the next start. Archived agents are allowed. The notice
   * line, the event and the restart are scheduled, never awaited: they queue behind the runtime's jobs, and a start
   * waiting in `prepare` holds none of the locks taken here.
   */
  async resetPersona(
    ref: string,
    /** The requester's tag, `<@ref>`: the `config_changed` event's `by`. */
    by: string,
  ): Promise<{ applied: "now" | "on_restart"; backupDir?: string }> {
    const { runtimes, workspace } = this.d;
    const row = await this.rowByRef(ref);
    this.assertPersistent(row);
    const tpl = await this.d.templates.loadValid(row.template);
    const agentsMd = path.join(tpl.dir, "AGENTS.md");
    // A regular file only: a link would copy its target's bytes into the agent's workdir.
    const templateFileOk = () =>
      lstat(agentsMd).then(
        (s) => s.isFile(),
        () => false,
      );
    const badTemplate = () =>
      new ApiError(
        409,
        "template_invalid",
        `Template ${row.template} needs an AGENTS.md that is a regular file.`,
      );
    if (!(await templateFileOk())) throw badTemplate();
    let r: Awaited<ReturnType<Workspace["resetPersona"]>>;
    try {
      r = await workspace.lock.run(ref, async () => {
        // Decided under the lock every start also takes, so a start can't slip in between. Docker: the container
        // must not be running either (spec §11.4 part 4).
        const rt = await runtimes.get(row.id);
        const canWriteNow = !rt?.hasProcess() && !(await this.containerRunning(row));
        return workspace.resetPersona(ref, agentsMd, { canWriteNow });
      });
    } catch (err) {
      // The template file went away after the check above: the template's fault, not the workdir's.
      if (!(await templateFileOk())) throw badTemplate();
      // Anything else here is the agent's workdir (a link planted in it, AGENTS.md not a file): never the template.
      if (err instanceof WorkspaceError) throw new ApiError(409, "workdir_unusable", err.message);
      throw err;
    }
    // Applied now with nothing differing changes nothing: no notice, no event.
    if (r.changed) this.scheduleResetEffects(row, ref, by, r);
    return { applied: r.applied, ...(r.backupDir ? { backupDir: r.backupDir } : {}) };
  }

  private scheduleResetEffects(
    row: AgentRow,
    ref: string,
    by: string,
    r: { applied: "now" | "on_restart"; backupDir?: string },
  ): void {
    const { runtimes, log, store, bus } = this.d;
    const staged = r.applied === "on_restart";
    const what = `AGENTS.md reset from template ${row.template}`;
    // Staged: the old file is saved when the next start applies it. Now: only when one existed to save.
    const saved = staged || r.backupDir ? "; the previous file is saved." : ".";
    const work = (async () => {
      const rt = await runtimes.get(row.id);
      const jobs: Promise<unknown>[] = [];
      // Through the runtime when loaded (published in seq order), else straight to the store, as ConfigChanges does.
      if (rt) jobs.push(rt.appendConfigChanged(by, [what]));
      else await store.append(row.id, null, { type: "config_changed", by, changes: [what] });
      bus.publishAll({ type: "config_changed", agent: ref });
      if (!row.archivedAt) {
        jobs.push(runtimes.recordConfigNotice(row.id, [`${what}${saved}`]));
        if (staged)
          jobs.push(runtimes.requestRestart(row.id, { changes: ["persona reset from template"] }));
      }
      for (const j of await Promise.allSettled(jobs))
        if (j.status === "rejected")
          log.error({ err: j.reason, agent: row.id }, "applying a persona reset failed");
    })();
    work.catch((err) => log.error({ err, agent: row.id }, "applying a persona reset failed"));
  }

  /** The overlay as stored; one that fails its schema (an agent made before I2) is kept as is for the editor to fix. */
  private overlayOf(row: AgentRow): Record<string, unknown> {
    return row.config as Record<string, unknown>;
  }

  async archive(ref: string, actor: Actor): Promise<AgentSummary> {
    const { db, runtimes } = this.d;
    const row = await this.rowByRef(ref);
    if (actor.kind === "agent" && actor.id === row.id)
      throw new OrgRefusedError("Ask a human to archive you.");
    this.assertNotLocal(actor, { agentRuntime: row.runtime });
    this.assertPersistent(row);
    if (row.archivedAt) return this.summary(ref);
    // S7 §5.7: the row lock first (`FOR NO KEY UPDATE`, never `FOR UPDATE`), then the live reports in the same
    // transaction, so a spawn committing in between can't leave an archived spawner a live child.
    const before = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ archivedAt: schema.agents.archivedAt })
        .from(schema.agents)
        .where(eq(schema.agents.id, row.id))
        .for("no key update");
      // A concurrent archive committed while this one waited on the lock: it wrote the peer events.
      if (locked?.archivedAt) return undefined;
      const liveRows = await tx
        .select({ id: schema.agents.id, kind: schema.agents.kind })
        .from(schema.agents)
        .where(and(eq(schema.agents.reportsTo, row.id), liveAgent));
      const handles = await principalsByIds(
        tx,
        liveRows.map((r) => r.id),
      );
      const live = liveRows.map((r) => ({ kind: r.kind, handle: handles.get(r.id)?.handle ?? "" }));
      const spawned = live
        .filter((r) => r.kind === "ephemeral")
        .map((r) => r.handle)
        .sort();
      if (spawned.length)
        throw new ApiError(
          409,
          "has_reports",
          spawnedMessage(await this.handleOfId(row.id), spawned),
          {
            reports: spawned,
          },
        );
      const reports = live.map((r) => r.handle).sort();
      if (reports.length)
        throw new ApiError(409, "has_reports", reportsMessage(reports), { reports });
      const snap = await this.snapshot(row.id, tx);
      await tx
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, row.id));
      return snap;
    });
    if (!before) return this.summary(ref);
    const rt = await runtimes.get(row.id);
    rt?.markArchived();
    try {
      await rt?.stop({ graceMs: 3000, termWaitMs: 10_000 });
    } catch (err) {
      this.d.log.error({ err, agent: ref }, "Stopping an archived agent failed");
    }
    await runtimes.refresh(row.id);
    await this.peerEvents(
      row.id,
      { kind: "left", reason: "archived", ...this.byOf(actor) },
      before,
    );
    this.orgAction(actor, "agent_archived", ref);
    return this.summary(ref);
  }

  async unarchive(ref: string, actor: Actor): Promise<AgentSummary> {
    const { db, runtimes } = this.d;
    const row = await this.rowByRef(ref);
    if (actor.kind === "agent" && row.manageOrg)
      throw new OrgRefusedError(
        `Only a human can unarchive @${await this.handleOfId(row.id)}: it can manage the org.`,
      );
    this.assertNotLocal(actor, { agentRuntime: row.runtime });
    this.assertPersistent(row);
    if (!row.archivedAt) return this.summary(ref);
    // S9 §10.1: the agent row `FOR NO KEY UPDATE` first, then its schedules (agents before schedules). The manager
    // check is inside the lock too, and a concurrent unarchive that lost the race changes nothing and emits nothing.
    const changed = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          archivedAt: schema.agents.archivedAt,
          reportsTo: schema.agents.reportsTo,
          manageOrg: schema.agents.manageOrg,
        })
        .from(schema.agents)
        .where(eq(schema.agents.id, row.id))
        .for("no key update");
      if (!locked?.archivedAt) return false;
      // A human may have granted manage_org since the read above.
      if (actor.kind === "agent" && locked.manageOrg)
        throw new OrgRefusedError(
          `Only a human can unarchive @${await this.handleOfId(row.id)}: it can manage the org.`,
        );
      if (locked.reportsTo) {
        const [m] = await tx
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, locked.reportsTo));
        if (m?.archivedAt)
          throw new ApiError(
            409,
            "manager_archived",
            `Its manager @${await this.handleOfId(m.id)} is archived. Change its manager first.`,
          );
      }
      await tx.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, row.id));
      await this.d.scheduling?.recomputeForTarget(tx, row.id);
      return true;
    });
    if (!changed) return this.summary(ref);
    await runtimes.refresh(row.id);
    // After the refresh: a firing in the millisecond before it reaches a runtime that still thinks the agent is
    // archived and is rejected (accepted, spec §10.1).
    this.d.scheduling?.changed();
    await this.peerEvents(row.id, { kind: "joined", ...this.byOf(actor) }, noPeers);
    this.orgAction(actor, "agent_unarchived", ref);
    return this.summary(ref);
  }
}
