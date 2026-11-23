import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../migrate.ts";
import { createTestDatabase } from "../testing.ts";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
beforeAll(async () => {
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  sql = postgres(tdb.url, { max: 1, onnotice: () => {} });
  await sql`insert into credentials (id, name, kind, value_enc) values ('c1','c1','oauth_token',${Buffer.from("x")}), ('c2','c2','oauth_token',${Buffer.from("x")})`;
  await sql`insert into handles (handle, kind) values ('lead','agent'),('kid-abcd','agent')`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id) values ('lead','lead','Lead','t','{}','local','c1')`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
            values ('kid','kid-abcd','Kid','t','{}','local','c2','ephemeral','lead', now(), 'lead')`;
});
afterAll(async () => {
  await sql.end();
  await tdb.drop();
});

test("#30: deleting a credential used only by a terminated agent nulls it", async () => {
  await sql`delete from credentials where id = 'c2'`;
  const [k] = await sql`select credential_id from agents where id = 'kid'`;
  expect(k?.credential_id).toBeNull();
});
test("#30: a live user still blocks the delete with 23514, atomically", async () => {
  await expect(sql`delete from credentials where id = 'c1'`).rejects.toMatchObject({
    code: "23514",
  });
  const [c] = await sql`select id from credentials where id = 'c1'`;
  expect(c).toBeDefined();
});
test("an ephemeral agent needs a manager; a persistent one can't be terminated", async () => {
  await expect(sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind)
                   values ('e2','e2-abcd','E','t','{}','local','c1','ephemeral')`).rejects.toMatchObject(
    {
      code: "23514",
    },
  );
  await expect(
    sql`update agents set terminated_at = now() where id = 'lead'`,
  ).rejects.toMatchObject({ code: "23514" });
});
test("a live row can't have a null credential", async () => {
  await expect(sql`update agents set credential_id = null where id = 'lead'`).rejects.toMatchObject(
    { code: "23514" },
  );
});
test("kind is persistent or ephemeral; new columns default", async () => {
  await expect(sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind)
                   values ('k2','k2','K','t','{}','local','c1','weird')`).rejects.toMatchObject({
    code: "23514",
  });
  const [l] =
    await sql`select workspace_pinned, workspace_deleted_at, last_activity_at from agents where id = 'lead'`;
  expect(l).toMatchObject({ workspace_pinned: false, workspace_deleted_at: null });
  expect(l?.last_activity_at).toBeInstanceOf(Date);
});
