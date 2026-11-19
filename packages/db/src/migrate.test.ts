import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb } from "./client.ts";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";
import { createTestDatabase } from "./testing.ts";

let tdb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.drop();
});

test("migrate creates auth tables and is idempotent; handle is unique", async () => {
  await migrate(tdb.url, MIGRATIONS_DIR);
  await migrate(tdb.url, MIGRATIONS_DIR); // second run is a no-op
  const { sql, close } = createDb(tdb.url);
  try {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["accounts", "sessions", "users", "verifications"]),
    );
    await sql`insert into users (id, name, email, handle) values ('1', 'A', 'a@x.io', 'dup')`;
    await expect(
      sql`insert into users (id, name, email, handle) values ('2', 'B', 'b@x.io', 'dup')`,
    ).rejects.toThrow(/users_handle_unique/);
  } finally {
    await close();
  }
});

test("0002 deletes pre-S4 agents (with their events) and adds the S4 tables", async () => {
  const fresh = await createTestDatabase();
  try {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    );
    // migrate to 0001 only, using a temp folder with the first two migrations
    const tmp = mkdtempSync(path.join(tmpdir(), "mig-"));
    mkdirSync(path.join(tmp, "meta"));
    for (const e of journal.entries.slice(0, 2))
      copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`));
    writeFileSync(
      path.join(tmp, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
    );
    await migrate(fresh.url, tmp);
    const { sql, close } = createDb(fresh.url);
    await sql`insert into agents (id, slug, display_name) values ('a1', 'dev', 'Dev agent')`;
    await sql`insert into session_events (agent_id, seq, type, payload) values ('a1', 1, 'process_started', '{}')`;
    await close();
    await migrate(fresh.url, MIGRATIONS_DIR);
    const h = createDb(fresh.url);
    try {
      expect(await h.sql`select count(*)::int as n from agents`).toEqual([{ n: 0 }]);
      expect(await h.sql`select count(*)::int as n from session_events`).toEqual([{ n: 0 }]);
      const tables = await h.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public'`;
      for (const t of ["templates", "projects", "credentials", "secrets", "agent_project_grants"])
        expect(tables.map((r) => r.table_name)).toContain(t);
    } finally {
      await h.close();
    }
  } finally {
    await fresh.drop();
  }
});
