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
  await sql`insert into tasks (id,title,created_by_user_id) values ('t1','One','u1'),('t2','Two','u1')`;
  await sql`insert into task_comments (id,task_id,author_agent_id,body) values ('k1','t1','a1','hi')`;
});
afterAll(() => close());

const ok = (q: Promise<unknown>) => expect(q).resolves.toBeTruthy();
const bad = (q: Promise<unknown>) => expect(q).rejects.toThrow(/check|violates/i);

test("keys come from a sequence", async () => {
  const rows = await sql`select number from tasks order by number`;
  expect(rows.map((r) => r.number)).toEqual([1, 2]);
});

test("every pre-S8 shape still passes and new shapes pass", async () => {
  await ok(
    sql`insert into messages (id,kind,from_user_id,to_agent_id,body) values ('m1','message','u1','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,to_all_humans,body,state) values ('m2','message','a1',true,'x','delivered') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('m3','member_update','a1','denied','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('m4','peer_left','a1','peer','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,to_agent_id,body) values ('m5','system','crash_recovered','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,subject_agent_id,to_all_humans,body,state) values ('m6','system','agent_errored','a1',true,'x','delivered') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('n1','task_assigned','t1','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_agent_id,body) values ('n2','task_comment','a2','t1','k1','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_user_id,task_id,comment_id,to_agent_id,body) values ('n3','task_comment','u1','t1','k1','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_all_humans,body,state) values ('n4','task_comment','a1','t1','k1',true,'x','delivered') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,task_id,to_agent_id,body) values ('n5','task_update','unblocked','t1','a1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,task_id,to_user_id,body,state) values ('n6','task_update','done','t1','u1','x','delivered') returning id`,
  );
});

test("wrong shapes are rejected", async () => {
  await bad(
    sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('b1','message','t1','a1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,from_agent_id,task_id,to_agent_id,body) values ('b2','task_assigned','a2','t1','a1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,task_id,to_agent_id,body) values ('b3','task_comment','t1','a1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,notice,task_id,to_agent_id,body) values ('b4','task_update','bogus','t1','a1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,notice,task_id,to_all_humans,body) values ('b5','task_update','done','t1',true,'x')`,
  );
  await bad(
    sql`insert into messages (id,kind,task_id,to_user_id,body) values ('b6','task_assigned','t1','u1','x')`,
  );
  await bad(sql`insert into tasks (id,title) values ('bt','no creator')`);
  await bad(
    sql`insert into task_links (id,task_id,position,kind,target,agent_id) values ('bl','t1',0,'agent','x','a1')`,
  );
  await bad(sql`insert into task_dependencies (task_id,depends_on_task_id) values ('t1','t1')`);
  await bad(
    sql`insert into inbox_items (id,user_id,kind,message_id) values ('bi','u1','bogus','n6')`,
  );
});

test("a message's comment must belong to its task (composite FK)", async () => {
  await expect(
    sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_agent_id,body) values ('f1','task_comment','a2','t2','k1','a1','x')`,
  ).rejects.toThrow(/foreign key/i);
});
