import { randomUUID } from "node:crypto";
import { type AgentRow, type Db, schema } from "@open-factory/db";
import { refOf } from "@open-factory/shared";
import { mentionOf } from "@open-factory/shared/mentions";
import { eq, getTableColumns, inArray } from "drizzle-orm";

/** An agent's row with its current handle and ref, which live on `principals` (the agent's id is its principal's id). */
export type AgentRecord = AgentRow & { handle: string; ref: string };
/** The columns that select an `AgentRecord` from `agents` inner-joined to `principals` on the id. */
export const agentRecordColumns = {
  ...getTableColumns(schema.agents),
  handle: schema.principals.handle,
  ref: schema.principals.ref,
};

/** Every agent column plus its handle: `agents` inner-joined to `principals` on the shared id. */
export const agentRecords = (tx: Tx) =>
  tx
    .select(agentRecordColumns)
    .from(schema.agents)
    .innerJoin(schema.principals, eq(schema.principals.id, schema.agents.id));

/** A database or a transaction on it. */
export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PrincipalKind = "agent" | "human";
export type Principal = { id: string; ref: string; kind: PrincipalKind; handle: string };

/** The handle belongs to another principal (spec §4.1: one namespace for agents and humans). */
export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`The handle ${handle} is taken`);
  }
}

const REF_ATTEMPTS = 5;

/** A unique violation on the principals' handle index (not the ref index, not any other table's). */
export function isHandleTaken(e: unknown): boolean {
  for (let x = e as { code?: string; constraint_name?: string; cause?: unknown } | undefined; x; ) {
    if (x.code === "23505" && x.constraint_name === "principals_handle_unique") return true;
    x = x.cause as typeof x;
  }
  return false;
}

/**
 * Makes a principal: a UUID id and `ref = refOf(id)`. A taken handle throws `HandleTakenError`; a ref collision
 * retries with a new id up to 5 times. Conflicts are detected with ON CONFLICT DO NOTHING, never as an error, so a
 * surrounding transaction stays usable.
 */
export async function createPrincipal(
  tx: Tx,
  kind: PrincipalKind,
  handle: string,
  newId: () => string = randomUUID,
): Promise<Principal> {
  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    const id = newId();
    const ref = refOf(id);
    const rows = await tx
      .insert(schema.principals)
      .values({ id, kind, handle, ref })
      .onConflictDoNothing()
      .returning({ id: schema.principals.id });
    if (rows.length) return { id, ref, kind, handle };
    const [holder] = await tx
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(eq(schema.principals.handle, handle));
    if (holder) throw new HandleTakenError(handle);
  }
  throw new Error("Couldn't find an unused ref for a new principal");
}

const toPrincipal = (r: typeof schema.principals.$inferSelect): Principal => ({
  id: r.id,
  ref: r.ref,
  kind: r.kind,
  handle: r.handle,
});

/** The mention of the principal `id`, read from `principals`; a missing principal is an error. */
export async function mentionOfPrincipal(tx: Tx, id: string): Promise<string> {
  const p = await principalById(tx, id);
  if (!p) throw new Error(`No principal ${id}`);
  return mentionOf(p.ref);
}

/** Who ended an agent as the `terminated` event and peer notices write it: a principal's mention, or `@factory` for the TTL (null). */
export async function terminatorMention(tx: Tx, terminatedBy: string | null): Promise<string> {
  return terminatedBy ? mentionOfPrincipal(tx, terminatedBy) : "@factory";
}

export async function principalById(tx: Tx, id: string): Promise<Principal | undefined> {
  const [row] = await tx.select().from(schema.principals).where(eq(schema.principals.id, id));
  return row && toPrincipal(row);
}

export async function principalsByIds(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, Principal>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select()
    .from(schema.principals)
    .where(inArray(schema.principals.id, [...ids]));
  return new Map(rows.map((r) => [r.id, toPrincipal(r)]));
}

/** Keyed by ref. */
export async function principalsByRefs(
  tx: Tx,
  refs: readonly string[],
): Promise<Map<string, Principal>> {
  if (!refs.length) return new Map();
  const rows = await tx
    .select()
    .from(schema.principals)
    .where(inArray(schema.principals.ref, [...refs]));
  return new Map(rows.map((r) => [r.ref, toPrincipal(r)]));
}

/** The agent row whose principal has this ref (already normalised), or undefined. */
export async function agentRowByRef(tx: Tx, ref: string): Promise<AgentRecord | undefined> {
  const [found] = await tx
    .select(agentRecordColumns)
    .from(schema.principals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.principals.id))
    .where(eq(schema.principals.ref, ref));
  return found;
}

/** Keyed by handle. */
export async function principalsByHandles(
  tx: Tx,
  handles: readonly string[],
): Promise<Map<string, Principal>> {
  if (!handles.length) return new Map();
  const rows = await tx
    .select()
    .from(schema.principals)
    .where(inArray(schema.principals.handle, [...handles]));
  return new Map(rows.map((r) => [r.handle, toPrincipal(r)]));
}
