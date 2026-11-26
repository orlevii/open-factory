import { type AgentRow, type Db, schema } from "@open-factory/db";
import { RESERVED_HANDLES } from "@open-factory/shared";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const RESERVED: readonly string[] = RESERVED_HANDLES;

/** `@humans` was an address for every person; people are addressed by handle now (spec §4.5). */
export const HUMANS_SEND_REFUSAL =
  "`@humans` isn't a handle. Message people by handle; list_peers lists them.";
export const HUMANS_MENTION_REFUSAL =
  "`@humans` isn't a handle. Mention people by handle; list_peers lists them.";

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
      kind: schema.principals.kind,
      agent: schema.agents,
      userId: schema.users.id,
      userHandle: schema.principals.handle,
      disabledAt: schema.users.disabledAt,
    })
    .from(schema.principals)
    .leftJoin(schema.agents, eq(schema.agents.id, schema.principals.id))
    .leftJoin(schema.users, eq(schema.users.id, schema.principals.id))
    .where(eq(schema.principals.handle, name))
    .limit(1);
  if (row?.kind === "agent" && row.agent) return { kind: "agent", agent: row.agent };
  if (row?.kind === "human" && row.userId && row.userHandle)
    return { kind: "user", userId: row.userId, handle: row.userHandle, disabled: !!row.disabledAt };
  return { kind: "none", name };
}
