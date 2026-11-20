import type postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./client.ts";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";
import { createTestDatabase } from "./testing.ts";

let sql: postgres.Sql;
let close: () => Promise<void>;
beforeAll(async () => {
  const t = await createTestDatabase();
  await migrate(t.url, MIGRATIONS_DIR);
  const h = createDb(t.url);
  sql = h.sql;
  close = async () => {
    await h.close();
    await t.drop();
  };
  await sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or'),('u2','Two','two@x.io','two')`;
  await sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id) values ('a1','dev','Dev','t','{}','local','c1')`;
  await sql`insert into tasks (id,title,created_by_user_id) values ('t1','One','u1')`;
});
afterAll(() => close());

test("factory_settings is a seeded singleton", async () => {
  const rows = await sql`select * from factory_settings`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: 1,
    max_running_agents: 8,
    default_warm_window_minutes: 70,
    member_update_debounce_seconds: 30,
  });
  await expect(sql`insert into factory_settings (id) values (2)`).rejects.toMatchObject({
    code: "23514",
  });
});

test("turns carry task and credential; deleting the credential or task nulls the reference", async () => {
  await sql`insert into credentials (id,name,kind,value_enc) values ('c3','turn-cred','oauth_token','\\x00')`;
  await sql`insert into turns (id,agent_id,started_at,task_id,credential_id) values ('r1','a1',now(),'t1','c3')`;
  await sql`delete from credentials where id = 'c3'`;
  expect((await sql`select credential_id, task_id from turns where id = 'r1'`)[0]).toEqual({
    credential_id: null,
    task_id: "t1",
  });
  await sql`delete from tasks where id = 't1'`;
  expect((await sql`select task_id from turns where id = 'r1'`)[0]?.task_id).toBeNull();
});

test("credentials rate-limit columns are nullable", async () => {
  await sql`insert into credentials (id,name,kind,value_enc) values ('c2','x','api_key','\\x00')`;
  const [r] =
    await sql`select rl_status, rl_type, rl_utilization, rl_resets_at, rl_observed_at from credentials where id = 'c2'`;
  expect(Object.values(r ?? {})).toEqual([null, null, null, null, null]);
});

test("invites: token_hash and used_by are unique", async () => {
  await sql`insert into invites (id,token_hash,created_by,expires_at,used_by) values ('i1','h1','u1',now() + interval '1 hour','u2')`;
  await expect(
    sql`insert into invites (id,token_hash,created_by,expires_at) values ('i2','h1','u1',now() + interval '1 hour')`,
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    sql`insert into invites (id,token_hash,created_by,expires_at,used_by) values ('i3','h3','u1',now() + interval '1 hour','u2')`,
  ).rejects.toMatchObject({ code: "23505" });
});

test("users.disabled_at is nullable", async () => {
  expect((await sql`select disabled_at, disabled_by from users where id = 'u1'`)[0]).toEqual({
    disabled_at: null,
    disabled_by: null,
  });
});
