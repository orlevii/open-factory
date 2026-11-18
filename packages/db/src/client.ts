import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string) {
  const sql = postgres(url, { onnotice: () => {} });
  const db: Db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
