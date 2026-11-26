import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createMigratedTestDatabase } from "../testing.ts";

let tdb: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
let sql: postgres.Sql;
beforeAll(async () => {
  tdb = await createMigratedTestDatabase();
  sql = postgres(tdb.url, { max: 1, onnotice: () => {} });
  await sql`insert into credentials (id, name, kind, value_enc) values ('c1','c1','oauth_token',${Buffer.from("x")}), ('c2','c2','oauth_token',${Buffer.from("x")})`;
  await sql`insert into principals (id, kind, handle, ref) values ('u1', 'human', 'or', substr(md5('u1'::text), 1, 8))`;
  await sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  await sql`insert into principals (id, kind, handle, ref) values ('lead', 'agent', 'lead', substr(md5('lead'::text), 1, 8))`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, reports_to) values ('lead','lead','Lead','t','{}','local','c1','u1')`;
  await sql`insert into principals (id, kind, handle, ref) values ('kid', 'agent', 'kid-abcd', substr(md5('kid'::text), 1, 8))`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to, terminated_at, terminated_by)
            values ('kid','kid-abcd','Kid','t','{}','local','c2','ephemeral','lead', now(), 'lead')`;
});
afterAll(async () => {
  await sql.end();
  await tdb.release();
});

test("deleting a credential used only by a terminated agent nulls it", async () => {
  await sql`delete from credentials where id = 'c2'`;
  const [k] = await sql`select credential_id from agents where id = 'kid'`;
  expect(k?.credential_id).toBeNull();
});
test("a live user still blocks the delete with 23514, atomically", async () => {
  await expect(sql`delete from credentials where id = 'c1'`).rejects.toMatchObject({
    code: "23514",
  });
  const [c] = await sql`select id from credentials where id = 'c1'`;
  expect(c).toBeDefined();
});
test("a persistent agent can't be terminated", async () => {
  await expect(
    sql`update agents set terminated_at = now() where id = 'lead'`,
  ).rejects.toMatchObject({ code: "23514" });
});
const insertAs = (id: string, kind: string, reportsTo: string | null) =>
  sql`insert into principals (id, kind, handle, ref) values (${id}, 'agent', ${id}, substr(md5(${id}::text), 1, 8)) on conflict do nothing`.then(
    () =>
      sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to)
      values (${id}, ${id}, 'X', 't', '{}', 'local', 'c1', ${kind}, ${reportsTo})`,
  );
test.each([
  ["a persistent agent", "persistent"],
  ["an ephemeral agent", "ephemeral"],
])("%s must have a manager", async (_name, kind) => {
  await expect(insertAs("bad-mgr", kind, null)).rejects.toMatchObject({ code: "23502" });
});
test("a manager must be a principal", async () => {
  await expect(insertAs("bad-mgr", "persistent", "nobody")).rejects.toMatchObject({
    code: "23503",
  });
});
test.each([
  ["a persistent agent reporting to an agent", "persistent", "lead"],
  ["a persistent agent reporting to a human", "persistent", "u1"],
  ["an ephemeral agent reporting to its spawner", "ephemeral", "lead"],
])("%s is accepted", async (_name, kind, reportsTo) => {
  await insertAs(`ok-${kind}-${reportsTo}`, kind, reportsTo);
});
test("a principal who manages an agent can't be deleted", async () => {
  await sql`insert into principals (id, kind, handle, ref) values ('boss', 'human', 'boss', substr(md5('boss'::text), 1, 8))`;
  await insertAs("managed", "persistent", "boss");
  await expect(sql`delete from principals where id = 'boss'`).rejects.toMatchObject({
    code: "23001",
  });
});
test("a live row can't have a null credential", async () => {
  await expect(sql`update agents set credential_id = null where id = 'lead'`).rejects.toMatchObject(
    { code: "23514" },
  );
});
test("kind is persistent or ephemeral", async () => {
  await sql`insert into principals (id, kind, handle, ref) values ('k2', 'agent', 'k2', substr(md5('k2'::text), 1, 8))`;
  await expect(sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to)
                   values ('k2','k2','K','t','{}','local','c1','weird','u1')`).rejects.toMatchObject(
    {
      code: "23514",
    },
  );
});
test("only a persistent agent can manage the org", async () => {
  await sql`insert into principals (id, kind, handle, ref) values ('e3', 'agent', 'e3-abcd', substr(md5('e3'::text), 1, 8))`;
  await expect(sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id, kind, reports_to, manage_org)
                   values ('e3','e3-abcd','E','t','{}','local','c1','ephemeral','lead', true)`).rejects.toMatchObject(
    {
      code: "23514",
    },
  );
  await sql`update agents set manage_org = true where id = 'lead'`;
  const [l] = await sql`select manage_org from agents where id = 'lead'`;
  expect(l?.manage_org).toBe(true);
});
test("a kind='message' row needs its recipients; other kinds don't", async () => {
  await expect(sql`insert into messages (id, kind, from_agent_id, to_agent_id, body)
                   values ('r1','message','lead','lead','x')`).rejects.toMatchObject({
    code: "23514",
  });
  await sql`insert into messages (id, kind, from_agent_id, to_agent_id, body, recipients)
            values ('r2','message','lead','lead','x', ${["@lead"]})`;
  await sql`insert into messages (id, kind, subject_agent_id, notice, to_agent_id, body)
            values ('r3','peer_joined','lead','peer','lead','x')`;
});
