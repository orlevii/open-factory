import { randomBytes } from "node:crypto";
import postgres from "postgres";

const DEFAULT_URL = "postgres://factory:factory@localhost:5432/factory";

/** Creates a throwaway database on DATABASE_URL's server. Call drop() in afterAll. */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const base = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  const name = `of_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const a = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists "${name}" with (force)`);
      await a.end();
    },
  };
}
