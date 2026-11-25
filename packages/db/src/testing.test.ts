import postgres from "postgres";
import { expect, onTestFinished, test } from "vitest";
import { createMigratedTestDatabase, type MigratedTestDatabase } from "./testing.ts";

const open = async () => {
  const db = await createMigratedTestDatabase();
  const sql = postgres(db.url, { max: 1, onnotice: () => {} });
  onTestFinished(async () => {
    await sql.end();
    await db.release();
  });
  return { db, sql };
};

/** Dirties a database the way a test would: rows, the seeded row changed, a sequence moved on. */
async function dirty(sql: postgres.Sql) {
  await sql`insert into handles (handle, kind) values ('or', 'user')`;
  await sql`update factory_settings set settings = '{"loopGuardMessages": 99}'`;
  await sql`select nextval('task_number_seq')`;
}

async function state(sql: postgres.Sql) {
  const [h] = await sql`select count(*)::int as n from handles`;
  const [f] = await sql`select settings from factory_settings where id = 1`;
  const [q] = await sql`select nextval('task_number_seq')::int as next`;
  return { handles: h?.n, settings: f?.settings, nextTask: q?.next };
}

test("a claimed database starts as the template: no rows, the seeded row as migrated, sequences from the start", async () => {
  const fresh = await open();
  const expected = await state(fresh.sql);
  expect(expected).toEqual({ handles: 0, settings: {}, nextTask: 1 });
  await dirty(fresh.sql);
  await fresh.sql.end();
  await fresh.db.release();

  // The released database is the lowest free one, so this claim gets it back (unless another worker claimed it
  // in between, and then this one was reset all the same).
  const again = await open();
  expect(await state(again.sql)).toEqual(expected);
});

test("databases claimed at the same time are different databases", async () => {
  const held: MigratedTestDatabase[] = [];
  onTestFinished(() => Promise.all(held.map((d) => d.release())).then(() => {}));
  held.push(await createMigratedTestDatabase(), await createMigratedTestDatabase());
  expect(new Set(held.map((d) => d.url)).size).toBe(2);
});

test("a database whose schema a test changed is rebuilt from the template on the next claim", async () => {
  const first = await open();
  await first.sql`create table stray (id int)`;
  await first.sql.end();
  await first.db.release();

  const again = await open();
  const [t] = await again.sql`select count(*)::int as n from pg_tables where tablename = 'stray'`;
  expect(t?.n).toBe(0);
});
