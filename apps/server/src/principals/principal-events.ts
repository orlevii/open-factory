import path from "node:path";
import { type Db, schema } from "@open-factory/db";
import { nameSchema, type PrincipalItem } from "@open-factory/shared";
import { eq, type SQL } from "drizzle-orm";
import type { EventBus } from "../agents/event-bus.ts";
import { avatarStat } from "../templates/avatar.ts";

/**
 * The principals matching `where` (all of them without one) as the API shows them. `GET /api/principals` and
 * `principal_updated` both read through here, so the two shapes can't drift.
 */
export async function loadPrincipalItems(
  db: Db,
  templatesDir: string,
  where?: SQL,
): Promise<PrincipalItem[]> {
  const rows = await db
    .select({
      id: schema.principals.id,
      ref: schema.principals.ref,
      kind: schema.principals.kind,
      handle: schema.principals.handle,
      userName: schema.users.name,
      disabledAt: schema.users.disabledAt,
      displayName: schema.agents.displayName,
      template: schema.agents.template,
      color: schema.agents.color,
      archivedAt: schema.agents.archivedAt,
      terminatedAt: schema.agents.terminatedAt,
    })
    .from(schema.principals)
    .leftJoin(schema.users, eq(schema.users.id, schema.principals.id))
    .leftJoin(schema.agents, eq(schema.agents.id, schema.principals.id))
    .where(where);

  // One avatar check per distinct template, live from disk like the agent summaries.
  const avatarOf = new Map(
    await Promise.all(
      [...new Set(rows.flatMap((r) => (r.template ? [r.template] : [])))].map(
        async (t) =>
          [
            t,
            nameSchema.safeParse(t).success
              ? (await avatarStat(path.join(templatesDir, t), templatesDir)).version
              : null,
          ] as const,
      ),
    ),
  );

  return rows.map((r): PrincipalItem => {
    const base = { id: r.id, ref: r.ref, kind: r.kind, handle: r.handle };
    if (r.kind === "human")
      return {
        ...base,
        name: r.userName ?? r.handle,
        state: r.disabledAt ? "disabled" : "live",
        avatar: null,
      };
    return {
      ...base,
      name: r.displayName ?? r.handle,
      state: r.terminatedAt ? "terminated" : r.archivedAt ? "archived" : "live",
      avatar: r.template
        ? { template: r.template, avatarVersion: avatarOf.get(r.template) ?? null, color: r.color }
        : null,
    };
  });
}

export type PrincipalPublisherDeps = {
  bus: Pick<EventBus, "publishAll">;
  db: Db;
  templatesDir: string;
};

/**
 * Tells every browser a principal was created or changed (handle, name, state): the full item as `principal_updated`.
 * Call it after the change has committed, never inside a transaction, so a rollback never leaks a frame.
 */
export async function publishPrincipal(d: PrincipalPublisherDeps, id: string): Promise<void> {
  const [principal] = await loadPrincipalItems(d.db, d.templatesDir, eq(schema.principals.id, id));
  if (principal) d.bus.publishAll({ type: "principal_updated", principal });
}

/** What services take: publishes the principal `id`, and logs rather than throws, because the change is already committed. */
export type PublishPrincipal = (id: string) => Promise<void>;
