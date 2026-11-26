import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "../client.ts";
import { createMigratedTestDatabase } from "../testing.ts";

let tdb: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
let h: ReturnType<typeof createDb>;
beforeAll(async () => {
  tdb = await createMigratedTestDatabase();
  h = createDb(tdb.url);
});
afterAll(async () => {
  await h.close();
  await tdb.release();
});

test("seq is unique per agent; deleting an agent cascades", async () => {
  const { sql } = h;
  await sql`insert into principals (id, kind, handle, ref) values ('u1', 'human', 'or', substr(md5('u1'::text), 1, 8))`;
  await sql`insert into users (id, name, email) values ('u1', 'Or', 'or@x.io')`;
  await sql`insert into credentials (id, name, kind, value_enc) values ('c1', 'main', 'oauth_token', ${Buffer.from("x")})`;
  await sql`insert into principals (id, kind, handle, ref) values ('a1', 'agent', 'dev', substr(md5('a1'::text), 1, 8))`;
  await sql`insert into principals (id, kind, handle, ref) values ('a2', 'agent', 'other', substr(md5('a2'::text), 1, 8))`;
  await sql`insert into agents (id, display_name, template, config, runtime, credential_id, reports_to)
    values ('a1', 'Dev agent', 'dev', '{}', 'local', 'c1', 'u1'), ('a2', 'Other', 'dev', '{}', 'local', 'c1', 'u1')`;
  await sql`insert into turns (id, agent_id, started_at) values ('t1', 'a1', now())`;
  await sql`insert into session_events (agent_id, seq, turn_id, type, payload) values ('a1', 1, 't1', 'turn_started', '{}')`;
  await sql`insert into session_events (agent_id, seq, type, payload) values ('a2', 1, 'process_started', '{"resumed":false}')`;
  await expect(
    sql`insert into session_events (agent_id, seq, type, payload) values ('a1', 1, 'x', '{}')`,
  ).rejects.toThrow(/session_events_agent_seq_unique/);
  await sql`delete from agents where id = 'a1'`;
  const [row] = await sql`select count(*)::int as n from session_events where agent_id = 'a1'`;
  expect(row?.n).toBe(0);
});

test("system rows need no user and a notice; user rows need a user and no notice", async () => {
  const { sql } = h;
  await sql`insert into principals (id, kind, handle, ref) values ('u2', 'human', 'al', substr(md5('u2'::text), 1, 8))`;
  await sql`insert into users (id, name, email) values ('u2', 'Al', 'al@x.io')`;
  await sql`insert into credentials (id, name, kind, value_enc) values ('c2', 'two', 'oauth_token', ${Buffer.from("x")})`;
  await sql`insert into principals (id, kind, handle, ref) values ('a3', 'agent', 'third', substr(md5('a3'::text), 1, 8))`;
  await sql`insert into agents (id, display_name, template, config, runtime, credential_id, reports_to)
    values ('a3', 'Third', 'dev', '{}', 'local', 'c2', 'u1')`;
  await sql`insert into messages (id, kind, from_id, to_id, body, notice) values ('n1','system',null,'a3','x','crash')`;
  await expect(
    sql`insert into messages (id, kind, from_id, to_id, body) values ('n2','system',null,'a3','x')`,
  ).rejects.toThrow(/check/i);
  await expect(
    sql`insert into messages (id, kind, from_id, to_id, body,recipient_ids) values ('n3','message',null,'a3','x','{a3}')`,
  ).rejects.toThrow(/check/i);
  await sql`insert into messages (id, kind, from_id, to_id, body,recipient_ids) values ('m2','message','u2','a3','x','{a3}')`;
});
