import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Valid when running from source (tests, tsx). The server bundle passes its own copied folder. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** The one place pending migrations are applied: server boot and test setup. */
export async function migrate(url: string, migrationsFolder: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await drizzleMigrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
