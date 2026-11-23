import { type AgentRow, type Db, schema } from "@open-factory/db";
import { RESERVED_HANDLES } from "@open-factory/shared";
import { eq, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const RESERVED: readonly string[] = RESERVED_HANDLES;

/**
 * Agent slugs and human handles share one namespace (spec §4.1). Claims a handle for `kind`; false means taken.
 * A reclaim is allowed only within the same kind and only while nothing references the claim. Callers validate
 * first (`handleSchema`/`slugSchema` refuse reserved names), so this never sees one.
 */
export async function claimHandle(
  db: Db | Tx,
  handle: string,
  kind: "agent" | "user",
): Promise<boolean> {
  const rows = await db.execute(sql`
    INSERT INTO handles (handle, kind) VALUES (${handle}, ${kind})
    ON CONFLICT (handle) DO UPDATE SET claimed_at = now()
      WHERE handles.kind = excluded.kind
        AND NOT EXISTS (SELECT 1 FROM users  WHERE users.handle = handles.handle)
        AND NOT EXISTS (SELECT 1 FROM agents WHERE agents.slug  = handles.handle)
    RETURNING handle`);
  return rows.length > 0;
}

/** The cheap pre-read: who holds this handle, if anyone. The claim is still the guarantee. */
export async function handleKind(
  db: Db | Tx,
  handle: string,
): Promise<"agent" | "user" | undefined> {
  const [row] = await db
    .select({ kind: schema.handles.kind })
    .from(schema.handles)
    .where(eq(schema.handles.handle, handle))
    .limit(1);
  return row?.kind as "agent" | "user" | undefined;
}

export type ResolvedName =
  | { kind: "agent"; agent: AgentRow }
  | { kind: "user"; userId: string; handle: string; disabled: boolean }
  | { kind: "reserved"; name: string }
  | { kind: "channel"; name: string }
  | { kind: "none"; name: string };

/** Trim; `#` is a channel; drop one leading `@`; reserved names before the lookup. Archived agents resolve (the router rejects them). */
export async function resolveName(db: Db | Tx, raw: string): Promise<ResolvedName> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) return { kind: "channel", name: trimmed };
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (RESERVED.includes(name)) return { kind: "reserved", name };
  const [row] = await db
    .select({
      kind: schema.handles.kind,
      agent: schema.agents,
      userId: schema.users.id,
      userHandle: schema.users.handle,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.handles)
    .leftJoin(schema.agents, eq(schema.agents.slug, schema.handles.handle))
    .leftJoin(schema.users, eq(schema.users.handle, schema.handles.handle))
    .where(eq(schema.handles.handle, name))
    .limit(1);
  if (row?.kind === "agent" && row.agent) return { kind: "agent", agent: row.agent };
  if (row?.kind === "user" && row.userId && row.userHandle)
    return { kind: "user", userId: row.userId, handle: row.userHandle, disabled: !!row.disabledAt };
  return { kind: "none", name };
}
