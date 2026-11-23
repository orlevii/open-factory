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
    await t.drop();
  };
  await sql`insert into users (id,name,email,handle) values ('u1','Or','or@x.io','or')`;
  await sql`insert into credentials (id,name,kind,value_enc) values ('c1','w','oauth_token','\\x00')`;
  await sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id) values
    ('a1','dev','Dev','t','{}','local','c1'),('a2','lead','Lead','t','{}','local','c1')`;
  await sql`insert into tasks (id,title,created_by_user_id) values ('t1','One','u1')`;
  await sql`insert into task_comments (id,task_id,author_agent_id,body) values ('k1','t1','a1','hi')`;
  await sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id,body_author_user_id,next_run_at)
    values ('s1','a1','0 9 * * 1-5','Europe/Berlin','Review','u1','u1',now())`;
  await sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id,body_author_user_id)
    values ('s2','a1','0 9 * * *','UTC','Other','u1','u1')`;
});
afterAll(() => close());

const ok = (q: Promise<unknown>) => expect(q).resolves.toBeTruthy();
const bad = (q: Promise<unknown>) => expect(q).rejects.toThrow(/check|violates|duplicate/i);

test("keys come from a sequence", async () => {
  const rows = await sql`select number from schedules order by number`;
  expect(rows.map((r) => r.number)).toEqual([1, 2]);
});

test("every S3-S8 shape still passes and the scheduled shape passes", async () => {
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
    sql`insert into messages (id,kind,from_agent_id,to_agent_id,body) values ('m3b','member_update','a1','a2','x') returning id`,
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

test("wrong scheduled shapes are rejected", async () => {
  const base = (cols: string, vals: string) =>
    sql.unsafe(
      `insert into messages (id,kind,to_agent_id,${cols},body) values ('bad','scheduled','a2',${vals},'x')`,
    );
  const full = "'s1','u1',now(),1,false";
  const cols = "schedule_id,author_user_id,due_at,firings,late";
  await ok(
    base(cols, full)
      .then(() => sql`delete from messages where id = 'bad'`)
      .then(() => [1]),
  );
  await bad(base("schedule_id,author_user_id,due_at,late", "'s1','u1',now(),false"));
  await bad(base(cols, "'s1','u1',now(),0,false"));
  await bad(
    base(
      "schedule_id,author_user_id,author_agent_id,due_at,firings,late",
      "'s1','u1','a1',now(),1,false",
    ),
  );
  await bad(base("schedule_id,due_at,firings,late", "'s1',now(),1,false"));
  await bad(base("author_user_id,due_at,firings,late", "'u1',now(),1,false"));
  await bad(base("schedule_id,author_user_id,due_at,firings", "'s1','u1',now(),1"));
  await bad(base("schedule_id,author_user_id,firings,late", "'s1','u1',1,false"));
  await bad(
    base(
      "schedule_id,author_user_id,due_at,firings,late,from_agent_id",
      "'s1','u1',now(),1,false,'a1'",
    ),
  );
  await bad(
    sql`insert into messages (id,kind,from_user_id,to_agent_id,schedule_id,body) values ('bad2','message','u1','a1','s1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,notice,task_id,firings,to_agent_id,body) values ('bad3','task_update','done','t1',1,'a1','x')`,
  );
  await bad(
    sql`insert into messages (id,kind,notice,to_agent_id,late,body) values ('bad4','system','crash_recovered','a1',false,'x')`,
  );
});

test("a scheduled row has no human recipient", async () => {
  await bad(
    sql`insert into messages (id,kind,to_agent_id,to_user_id,schedule_id,author_user_id,due_at,firings,late,body)
        values ('tu','scheduled','a1','u1','s1','u1',now(),1,false,'x')`,
  );
});

test("at most one pending row per schedule and target", async () => {
  await ok(sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body)
    values ('p1','scheduled','a2','s1','u1',now(),1,false,'x') returning id`);
  await expect(
    sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body)
      values ('p2','scheduled','a2','s1','u1',now(),1,false,'x')`,
  ).rejects.toThrow(/duplicate|unique/i);
  await sql`update messages set state = 'delivered' where id = 'p1'`;
  await ok(sql`insert into messages (id,kind,to_agent_id,schedule_id,author_user_id,due_at,firings,late,body)
    values ('p3','scheduled','a2','s1','u1',now(),1,false,'x') returning id`);
});

test("schedules: exactly one of cron and run_at, one creator, one author", async () => {
  await bad(sql`insert into schedules (id,target_agent_id,cron,run_at,timezone,body,created_by_user_id,body_author_user_id)
    values ('x1','a1','* * * * *',now(),'UTC','b','u1','u1')`);
  await bad(sql`insert into schedules (id,target_agent_id,timezone,body,created_by_user_id,body_author_user_id)
    values ('x2','a1','UTC','b','u1','u1')`);
  await bad(sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id,created_by_agent_id,body_author_user_id)
    values ('x3','a1','* * * * *','UTC','b','u1','a1','u1')`);
  await bad(sql`insert into schedules (id,target_agent_id,cron,timezone,body,created_by_user_id)
    values ('x4','a1','* * * * *','UTC','b','u1')`);
  await ok(sql`insert into schedules (id,target_agent_id,run_at,timezone,body,created_by_agent_id,body_author_agent_id)
    values ('x5','a1',now(),'UTC','b','a2','a2') returning id`);
});
