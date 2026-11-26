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
const bad = (q: Promise<unknown>) => expect(q).rejects.toThrow(/check|violates|duplicate/i);

test("keys come from a sequence", async () => {
  const rows = await sql`select number from schedules order by number`;
  expect(rows.map((r) => r.number)).toEqual([1, 2]);
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
    sql`insert into messages (id,kind,from_user_id,to_agent_id,schedule_id,body,recipients) values ('bad2','message','u1','a1','s1','x','{@test}')`,
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
