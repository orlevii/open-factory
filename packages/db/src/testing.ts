import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";

const DEFAULT_URL = "postgres://factory:factory@localhost:5432/factory";

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

const baseUrl = () => new URL(process.env.DATABASE_URL ?? DEFAULT_URL);

const adminConnection = () => postgres(baseUrl().toString(), { max: 1, onnotice: () => {} });

function dbUrl(name: string): string {
  const url = baseUrl();
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(name: string, template?: string): Promise<TestDatabase> {
  const admin = adminConnection();
  try {
    await admin.unsafe(`create database "${name}"${template ? ` template "${template}"` : ""}`);
  } finally {
    await admin.end();
  }
  return {
    url: dbUrl(name),
    async drop() {
      const a = adminConnection();
      try {
        await a.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}

/** Creates an empty throwaway database on DATABASE_URL's server. Call drop() in afterAll. */
export function createTestDatabase(): Promise<TestDatabase> {
  return createDatabase(`of_test_${randomBytes(6).toString("hex")}`);
}

/** The migrations folder's content hash: a changed or added migration gets a new template. */
function migrationsHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 16);
}

let templateName: Promise<string> | undefined;

/**
 * The fully migrated template database for this migrations folder, built once per server: the first caller
 * (any worker, any process) migrates it under an advisory lock, everyone else reuses it.
 */
function migratedTemplate(): Promise<string> {
  templateName ??= (async () => {
    const name = `of_tmpl_${migrationsHash(MIGRATIONS_DIR)}`;
    const admin = adminConnection();
    try {
      await admin`select pg_advisory_lock(hashtext(${name}))`;
      try {
        const [row] = await admin`select datistemplate from pg_database where datname = ${name}`;
        if (row?.datistemplate) return name;
        // A crashed build leaves a database that never became a template: rebuild it.
        if (row) await admin.unsafe(`drop database "${name}" with (force)`);
        await admin.unsafe(`create database "${name}"`);
        await migrate(dbUrl(name), MIGRATIONS_DIR);
        await admin.unsafe(`alter database "${name}" is_template true allow_connections false`);
        return name;
      } finally {
        await admin`select pg_advisory_unlock(hashtext(${name}))`;
      }
    } finally {
      await admin.end();
    }
  })();
  templateName.catch(() => {
    templateName = undefined;
  });
  return templateName;
}

/**
 * A throwaway database with every migration applied, copied from a template that is migrated once
 * (far cheaper than running the migrations per test). Call drop() when done.
 */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  return createDatabase(`of_test_${randomBytes(6).toString("hex")}`, await migratedTemplate());
}
