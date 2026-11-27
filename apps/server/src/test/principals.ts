import { createHash } from "node:crypto";
import { type Db, schema } from "@open-factory/db";
import { refOf } from "@open-factory/shared";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import {
  createPrincipal,
  type Principal,
  type PrincipalKind,
} from "../principals/principal-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A ref for a fixture id: refOf for a real UUID, a hash of the id otherwise (fixtures use ids like `u1`). */
export function testRef(id: string): string {
  return refOf(UUID.test(id) ? id : createHash("sha1").update(id).digest("hex"));
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** An idempotent INSERT for a fixture principal (a test may delete its agents and re-seed them), for raw-SQL tests: `await sql.unsafe(principalSql("a1", "agent", "dev"))`. */
export function principalSql(id: string, kind: PrincipalKind, handle: string): string {
  return `insert into principals (id, kind, handle, ref) values (${quote(id)}, ${quote(kind)}, ${quote(handle)}, ${quote(testRef(id))}) on conflict do nothing`;
}

/** A well-formed ref that no principal holds. */
export const UNKNOWN_REF = "zzzzzzzz";

/** The ref of the principal with this handle: what URLs and services address an agent by. */
export async function refOfHandle(db: Db, handle: string): Promise<string> {
  const [p] = await db
    .select({ ref: schema.principals.ref })
    .from(schema.principals)
    .where(eq(schema.principals.handle, handle));
  if (!p) throw new Error(`no principal @${handle}`);
  return p.ref;
}

/** A principal with the given id (a fresh UUID when omitted); the id may be any fixture string such as `u1`. */
export async function seedTestPrincipal(
  db: Db,
  kind: PrincipalKind,
  handle: string,
  id?: string,
): Promise<Principal> {
  if (!id) return createPrincipal(db, kind, handle);
  const ref = testRef(id);
  await db.insert(schema.principals).values({ id, kind, handle, ref });
  return { id, ref, kind, handle };
}

/** A human principal plus its user row, same id (`u-<handle>` when omitted). Idempotent per handle. */
export async function seedTestUser(
  db: Db,
  handle: string,
  id = `u-${handle}`,
  name = handle.charAt(0).toUpperCase() + handle.slice(1),
): Promise<Principal> {
  const [existing] = await db
    .select()
    .from(schema.principals)
    .where(eq(schema.principals.handle, handle));
  const principal = existing
    ? { id: existing.id, ref: existing.ref, kind: existing.kind, handle }
    : await seedTestPrincipal(db, "human", handle, id);
  await db
    .insert(schema.users)
    .values({ id: principal.id, name, email: `${handle}@example.invalid` })
    .onConflictDoNothing();
  return principal;
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
  return (await seedTestUser(db, "test-mgr", "test-mgr", "Test manager")).id;
}

/** `testManagerUserId` for fixtures that only hold a raw SQL client. */
export async function testManagerUserIdSql(sql: postgres.Sql): Promise<string> {
  const [first] = await sql`select id from users order by created_at, id limit 1`;
  if (first) return String(first.id);
  await sql.unsafe(principalSql("test-mgr", "human", "test-mgr"));
  await sql`insert into users (id, name, email) values ('test-mgr', 'Test manager', 'test-mgr@example.invalid') on conflict do nothing`;
  return "test-mgr";
}
