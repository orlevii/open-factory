import type postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./client.ts";
import { createMigratedTestDatabase } from "./testing.ts";

let sql: postgres.Sql;
let close: () => Promise<void>;
beforeAll(async () => {
  const t = await createMigratedTestDatabase();
  const h = createDb(t.url);
  sql = h.sql;
  close = async () => {
    await h.close();
    await t.release();
  };
  await sql`insert into principals (id, kind, handle, ref) values ('u1', 'human', 'or', substr(md5('u1'::text), 1, 8))`;
  await sql`insert into users (id, name, email) values ('u1','Or','or@x.io')`;
  await sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await sql`insert into principals (id, kind, handle, ref) values ('a1', 'agent', 'dev', substr(md5('a1'::text), 1, 8))`;
  await sql`insert into principals (id, kind, handle, ref) values ('a2', 'agent', 'lead', substr(md5('a2'::text), 1, 8))`;
  await sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id,reports_to) values
    ('a1','dev','Dev','t','{}','local','c1','u1'),('a2','lead','Lead','t','{}','local','c1','u1')`;
  await sql`insert into tasks (id,title,created_by_user_id) values ('t1','One','u1')`;
  await sql`insert into task_comments (id,task_id,author_agent_id,body) values ('k1','t1','a1','hi')`;
  await sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id,body_author_user_id,next_run_at)
    values ('s1','a1','0 9 * * 1-5','Europe/Berlin','Review','u1','u1',now())`;
  await sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id,body_author_user_id)
    values ('s2','a1','0 9 * * *','UTC','Other','u1','u1')`;
});
afterAll(() => close());

const ok = (q: Promise<unknown>) => expect(q).resolves.toBeTruthy();
const bad = (q: Promise<unknown>) => expect(q).rejects.toThrow(/check/i);

test("every valid sender/recipient shape passes (chat, member, system, task and scheduled)", async () => {
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
    sql`insert into messages (id,kind,from_agent_id,to_user_id,body) values ('4u','member_update','a1','u1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_user_id,body) values ('5u','member_update','a1','denied','u1','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('6','peer_joined','a1','peer','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,subject_agent_id,notice,to_agent_id,body) values ('6b','peer_left','a1','peer','a2','x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,subject_agent_id,to_all_humans,body,state) values ('7','system','agent_errored','a1',true,'x','delivered') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,notice,to_agent_id,body) values ('8','system','crash_recovered','a1','x') returning id`,
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
  await ok(
    sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body)
        values ('sc1','scheduled','a1','s1','u1',now(),1,false,'x') returning id`,
  );
  await ok(
    sql`insert into messages (id,kind,to_agent_id,schedule_id,author_agent_id,due_at,firings,late,body)
        values ('sc2','scheduled','a1','s2','a2',now(),3,true,'x') returning id`,
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

test("a loop_held message row inserts, pointing at its open loop hold", async () => {
  await sql`insert into loop_holds (id,agent_a,agent_b,opened_at) values ('h1','a1','a2',now())`;
  await ok(
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,body,recipients,state,loop_hold_id)
        values ('lh1','message','a1','a2','x','{@test}','loop_held','h1') returning id`,
  );
});

test("a pair has at most one open loop hold", async () => {
  await expect(
    sql`insert into loop_holds (id,agent_a,agent_b,opened_at) values ('h2','a1','a2',now())`,
  ).rejects.toThrow(/unique/i);
});

test("loop holds store the pair in agent order", async () => {
  await bad(
    sql`insert into loop_holds (id,agent_a,agent_b,opened_at) values ('h3','a2','a1',now())`,
  );
});

test("a schedule has one pending or loop_held row per agent, not two", async () => {
  await sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body)
      values ('sp1','scheduled','a2','s2','u1',now(),1,false,'x')`;
  await expect(
    sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body,state)
        values ('sp2','scheduled','a2','s2','u1',now(),2,false,'x','loop_held')`,
  ).rejects.toThrow(/unique/i);
});
