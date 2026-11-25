import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createMigratedTestDatabase } from "../testing.ts";

let tdb: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
let sql: postgres.Sql;
beforeAll(async () => {
  tdb = await createMigratedTestDatabase();
  sql = postgres(tdb.url, { max: 1, onnotice: () => {} });
  await sql`insert into credentials (id, name, kind, value_enc) values ('c1','c1','oauth_token',${Buffer.from("x")})`;
  await sql`insert into handles (handle, kind) values ('boss','user')`;
  await sql`insert into users (id, name, email, handle) values ('u0','Boss','boss@x.io','boss')`;
});
afterAll(async () => {
  await sql.end();
  await tdb.drop();
});

test("an agent row needs a handles row", async () => {
  await expect(
    sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, reports_to_user)
        values ('a1','nohandle','A','t','{}','local','c1','u0')`,
  ).rejects.toThrow(/foreign key/);
});
test("a user row needs a handles row", async () => {
  await expect(
    sql`insert into users (id, name, email, handle) values ('u1','U','u@x.io','nohandle')`,
  ).rejects.toThrow(/foreign key/);
});
test("a claimed handle is taken once", async () => {
  await sql`insert into handles (handle, kind) values ('dev', 'agent')`;
  await expect(sql`insert into handles (handle, kind) values ('dev', 'user')`).rejects.toThrow(
    /duplicate key/,
  );
});
test("kind is checked", async () => {
  await expect(sql`insert into handles (handle, kind) values ('x1', 'reserved')`).rejects.toThrow(
    /check/,
  );
});
