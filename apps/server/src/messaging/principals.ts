import { type AgentRow, type Db, schema } from "@open-factory/db";
import { RESERVED_HANDLES } from "@open-factory/shared";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const RESERVED: readonly string[] = RESERVED_HANDLES;

/** Agent slugs and human handles share one namespace (spec §7.1). Archived agents keep their slug. */
export async function isNameTaken(
  db: Db | Tx,
  name: string,
): Promise<"reserved" | "user" | "agent" | false> {
  if (RESERVED.includes(name)) return "reserved";
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.handle, name))
    .limit(1);
  if (user) return "user";
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.slug, name))
    .limit(1);
  return agent ? "agent" : false;
}

export type ResolvedName =
  | { kind: "agent"; agent: AgentRow }
  | { kind: "user"; userId: string; handle: string }
  | { kind: "humans" }
  | { kind: "reserved"; name: string }
  | { kind: "ambiguous"; name: string }
  | { kind: "none"; name: string };

/** Trim, drop one leading `@`, then look the name up in both tables. Archived agents resolve (the router rejects them). */
export async function resolveName(db: Db | Tx, raw: string): Promise<ResolvedName> {
  const trimmed = raw.trim();
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (name === "humans") return { kind: "humans" };
  if (RESERVED.includes(name)) return { kind: "reserved", name };
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.slug, name))
    .limit(1);
  const [user] = await db
    .select({ id: schema.users.id, handle: schema.users.handle })
    .from(schema.users)
    .where(eq(schema.users.handle, name))
    .limit(1);
  if (agent && user) return { kind: "ambiguous", name };
  if (agent) return { kind: "agent", agent };
  if (user) return { kind: "user", userId: user.id, handle: user.handle };
  return { kind: "none", name };
}
