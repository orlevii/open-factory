import { type Db, schema } from "@open-factory/db";
import type postgres from "postgres";

/** Claims a handle for a fixture row (agents.slug and users.handle reference it). Idempotent. */
export async function claimTestHandle(
  db: Pick<Db, "insert">,
  handle: string,
  kind: "agent" | "user",
): Promise<void> {
  await db.insert(schema.handles).values({ handle, kind }).onConflictDoNothing();
}

/** `claimTestHandle` for fixtures that only hold a raw SQL client. */
export async function claimTestHandleSql(
  sql: postgres.Sql,
  handle: string,
  kind: "agent" | "user",
): Promise<void> {
  await sql`insert into handles (handle, kind) values (${handle}, ${kind}) on conflict do nothing`;
}
