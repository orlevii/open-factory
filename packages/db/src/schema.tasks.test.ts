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
  await sql`insert into agents (id,slug,display_name,template,config,runtime,credential_id,reports_to_user) values
    ('a1','dev','Dev','t','{}','local','c1','u1'),('a2','lead','Lead','t','{}','local','c1','u1')`;
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

test("wrong shapes are rejected", async () => {
  await bad(
    sql`insert into messages (id,kind,task_id,to_agent_id,body,recipients) values ('b1','message','t1','a1','x','{@test}')`,
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
  await sql`insert into messages (id,kind,notice,task_id,to_user_id,body,state) values ('n6','task_update','done','t1','u1','x','delivered')`;
  await bad(
    sql`insert into inbox_items (id,user_id,kind,message_id) values ('bi','u1','bogus','n6')`,
  );
});

test("a message's comment must belong to its task (composite FK)", async () => {
  await expect(
    sql`insert into messages (id,kind,from_agent_id,task_id,comment_id,to_agent_id,body) values ('f1','task_comment','a2','t2','k1','a1','x')`,
  ).rejects.toThrow(/foreign key/i);
});

test("a credential notice: the credential inbox kind, and the notice cascades with its credential", async () => {
  await sql`insert into credentials (id,name,kind,value_enc) values ('c9','unused','oauth_token','\\x00')`;
  await ok(
    sql`insert into messages (id,kind,notice,subject_credential_id,to_all_humans,body,state) values ('cn1','system','credential_expiring','c9',true,'work expires on 2027-11-12.','delivered') returning id`,
  );
  await ok(
    sql`insert into inbox_items (id,user_id,kind,message_id) values ('ci1','u1','credential','cn1') returning id`,
  );
  await bad(
    sql`insert into inbox_items (id,user_id,kind,message_id) values ('ci2','u1','bogus','cn1')`,
  );
  await sql`delete from credentials where id = 'c9'`;
  const [m] = await sql`select count(*)::int as n from messages where subject_credential_id = 'c9'`;
  const [i] = await sql`select count(*)::int as n from inbox_items where message_id = 'cn1'`;
  expect(m?.n).toBe(0);
  expect(i?.n).toBe(0);
});
