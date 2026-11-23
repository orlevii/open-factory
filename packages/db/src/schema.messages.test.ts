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
  await sql`insert into handles (handle, kind) values ('or','user'),('dev','agent'),('lead','agent')`;
  await sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or')`;
  await sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id) values
    ('a1','dev','Dev','t','{}','local','c1'),('a2','lead','Lead','t','{}','local','c1')`;
});
afterAll(() => close());

const ok = (q: Promise<unknown>) => expect(q).resolves.toBeTruthy();
const bad = (q: Promise<unknown>) => expect(q).rejects.toThrow(/check/i);

test("valid sender/recipient combinations", async () => {
  await ok(
    sql`insert into messages (id,kind,from_user_id,to_agent_id,body,recipients) values ('1','message','u1','a1','x','{@test}') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,body,recipients) values ('2','message','a1','a2','x','{@test}') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,to_all_humans,body,state,recipients) values ('3','message','a1',true,'x','delivered','{@test}') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,body) values ('4','member_update','a1','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('5','member_update','a1','denied','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('6','peer_joined','a1','peer','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,subject_agent_id,to_all_humans,body,state) values ('7','system','agent_errored','a1',true,'x','delivered') returning id`,
  );
});

test("invalid combinations are rejected", async () => {
  await bad(
    sql`insert into messages (id,kind,from_user_id,from_agent_id,to_agent_id,body,recipients) values ('b1','message','u1','a1','a2','x','{@test}')`,
  );
  await bad(
    sql`insert into messages (id,kind,from_agent_id,subject_agent_id,notice,to_agent_id,body) values ('b2','member_update','a1','a1','denied','a2','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,from_agent_id,to_all_humans,body) values ('b3','member_update','a1',true,'x')`,
  );
  await bad(
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,to_all_humans,body,recipients) values ('b4','message','a1','a2',true,'x','{@test}')`,
  );
  await bad(
    sql`insert into messages (id,kind,subject_agent_id,to_agent_id,body) values ('b5','peer_left','a1','a2','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,body,state,recipients) values ('b6','message','a1','a2','x','lost','{@test}')`,
  );
});

test("inbox_items is unique per user and message", async () => {
  await sql`insert into inbox_items (id,user_id,kind,message_id) values ('i1','u1','message','3')`;
  await expect(
    sql`insert into inbox_items (id,user_id,kind,message_id) values ('i2','u1','message','3')`,
  ).rejects.toThrow(/unique/i);
});
