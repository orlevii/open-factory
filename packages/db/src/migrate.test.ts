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
