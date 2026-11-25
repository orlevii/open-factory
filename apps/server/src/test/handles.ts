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

/**
 * A manager for a fixture's persistent agent (every one reports to an agent or a human, I9 §4.5): the oldest existing
 * user, or a fixture user `test-mgr` made on first use so the fixture adds nobody when a user exists already.
 */
export async function testManagerUserId(db: Db): Promise<string> {
  const [first] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(schema.users.createdAt, schema.users.id)
    .limit(1);
  if (first) return first.id;
  await claimTestHandle(db, "test-mgr", "user");
  await db
    .insert(schema.users)
    .values({
      id: "test-mgr",
      name: "Test manager",
      email: "test-mgr@example.invalid",
      handle: "test-mgr",
    })
    .onConflictDoNothing();
  return "test-mgr";
}

/** `testManagerUserId` for fixtures that only hold a raw SQL client. */
export async function testManagerUserIdSql(sql: postgres.Sql): Promise<string> {
  const [first] = await sql`select id from users order by created_at, id limit 1`;
  if (first) return String(first.id);
  await claimTestHandleSql(sql, "test-mgr", "user");
  await sql`insert into users (id, name, email, handle)
            values ('test-mgr', 'Test manager', 'test-mgr@example.invalid', 'test-mgr') on conflict do nothing`;
  return "test-mgr";
}

/** An enabled user fixture (handle `or`, id `u-or` unless given), claimed through `handles`. Idempotent; returns its id. */
export async function seedTestUser(
  db: Db,
  u: { id?: string; handle?: string; name?: string } = {},
): Promise<string> {
  const handle = u.handle ?? "or";
  const id = u.id ?? `u-${handle}`;
  await claimTestHandle(db, handle, "user");
  await db
    .insert(schema.users)
    .values({ id, name: u.name ?? "Or", email: `${handle}@example.invalid`, handle })
    .onConflictDoNothing();
  return id;
}
