import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "../client.ts";
import { MIGRATIONS_DIR, migrate } from "../migrate.ts";
import { createTestDatabase } from "../testing.ts";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
let h: ReturnType<typeof createDb>;
beforeAll(async () => {
  tdb = await createTestDatabase();
  await migrate(tdb.url, MIGRATIONS_DIR);
  h = createDb(tdb.url);
});
afterAll(async () => {
  await h.close();
  await tdb.drop();
});

test("agent tables exist; seq is unique per agent; deleting an agent cascades", async () => {
  const { sql } = h;
  await sql`insert into handles (handle, kind) values ('or','user'),('dev','agent'),('other','agent')`;
  await sql`insert into users (id, name, email, handle) values ('u1', 'Or', 'or@x.io', 'or')`;
  await sql`insert into credentials (id, name, kind, value_enc) values ('c1', 'main', 'oauth_token', ${Buffer.from("x")})`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id)
    values ('a1', 'dev', 'Dev agent', 'dev', '{}', 'local', 'c1'), ('a2', 'other', 'Other', 'dev', '{}', 'local', 'c1')`;
  const [a] = await sql`
    select status, description, session_id, kind, reports_to, grants_overridden, archived_at
    from agents where id = 'a1'`;
  expect(a).toEqual({
    status: "hibernated",
    description: "",
    session_id: null,
    kind: "persistent",
    reports_to: null,
    grants_overridden: false,
    archived_at: null,
  });
  await sql`insert into turns (id, agent_id, started_at) values ('t1', 'a1', now())`;
  await sql`insert into session_events (agent_id, seq, turn_id, type, payload) values ('a1', 1, 't1', 'turn_started', '{}')`;
  await sql`insert into session_events (agent_id, seq, type, payload) values ('a2', 1, 'process_started', '{"resumed":false}')`;
  await expect(
    sql`insert into session_events (agent_id, seq, type, payload) values ('a1', 1, 'x', '{}')`,
  ).rejects.toThrow(/session_events_agent_seq_unique/);
  await sql`insert into messages (id, from_user_id, to_agent_id, body) values ('m1', 'u1', 'a1', 'hi')`;
  const [m] =
    await sql`select kind, state, urgent, delivered_turn_id from messages where id = 'm1'`;
  expect(m).toEqual({ kind: "message", state: "pending", urgent: false, delivered_turn_id: null });
  await sql`delete from agents where id = 'a1'`;
  const [row] = await sql`select count(*)::int as n from session_events where agent_id = 'a1'`;
  expect(row?.n).toBe(0);
});

test("0003: system rows need no user and a notice; user rows need a user and no notice", async () => {
  const { sql } = h;
  await sql`insert into handles (handle, kind) values ('al','user'),('third','agent')`;
  await sql`insert into users (id, name, email, handle) values ('u2', 'Al', 'al@x.io', 'al')`;
  await sql`insert into credentials (id, name, kind, value_enc) values ('c2', 'two', 'oauth_token', ${Buffer.from("x")})`;
  await sql`insert into agents (id, slug, display_name, template, config, runtime, credential_id)
    values ('a3', 'third', 'Third', 'dev', '{}', 'local', 'c2')`;
  await sql`insert into messages (id, kind, from_user_id, to_agent_id, body, notice) values ('n1','system',null,'a3','x','crash')`;
  await expect(
    sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('n2','system',null,'a3','x')`,
  ).rejects.toThrow(/check/i);
  await expect(
    sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('n3','message',null,'a3','x')`,
  ).rejects.toThrow(/check/i);
  await sql`insert into messages (id, kind, from_user_id, to_agent_id, body) values ('m2','message','u2','a3','x')`;
  const [a] =
    await sql`select attempting, rate_limit_notice_owed, runtime_journal, last_error, error_kind from agents where id = 'a3'`;
  expect(a).toEqual({
    attempting: false,
    rate_limit_notice_owed: false,
    runtime_journal: null,
    last_error: null,
    error_kind: null,
  });
  const [c] =
    await sql`select rate_limited_until, rate_limit_exact from credentials where id = 'c2'`;
  expect(c).toEqual({ rate_limited_until: null, rate_limit_exact: true });
});
