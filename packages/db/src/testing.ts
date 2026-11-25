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

/*
 * Migrated test databases are pooled: a database is claimed with a session advisory lock (released when its
 * process ends, however it ends), reset when claimed, and given back on release. Creating a database copies the
 * template and dropping one forces a checkpoint; under a parallel run a drop took ~0.4 s, a reset takes ~25 ms.
 * The pool is per migrations folder, shared by every worker and every run on the same migrations.
 */
const POOL = "of_pool_";
const poolOf = (template: string) => `${POOL}${template.slice("of_tmpl_".length)}_`;

/** This process's admin connection: it holds the claims' advisory locks and runs the pool's admin statements. */
let holder: postgres.Sql | undefined;
const claimed = new Set<string>();
let swept = false;

/** A pool's lock key: the pool name, and the database's number in it. */
const lockKey = (name: string) => {
  const at = name.lastIndexOf("_");
  return [name.slice(0, at), Number(name.slice(at + 1))] as const;
};

async function tryLock(sql: postgres.Sql, name: string): Promise<boolean> {
  const [pool, n] = lockKey(name);
  const [row] = await sql`select pg_try_advisory_lock(hashtext(${pool}), ${n}) as ok`;
  return row?.ok === true;
}

async function unlock(sql: postgres.Sql, name: string) {
  const [pool, n] = lockKey(name);
  await sql`select pg_advisory_unlock(hashtext(${pool}), ${n})`;
}

/** Drops the pooled databases of other migrations folders that nobody holds (a changed migration's old pool). */
async function sweepOtherPools(sql: postgres.Sql, pool: string) {
  const rows =
    await sql`select datname from pg_database where datname like ${`${POOL}%`} and datname not like ${`${pool}%`}`;
  for (const { datname } of rows) {
    if (!/_\d+$/.test(datname) || !(await tryLock(sql, datname))) continue;
    try {
      await sql.unsafe(`drop database if exists "${datname}" with (force)`);
    } finally {
      await unlock(sql, datname);
    }
  }
}

interface Seed {
  tables: string[];
  rows: Map<string, postgres.Row[]>;
  /** Every sequence's position, owned by a column or not (`task_number_seq`). */
  sequences: { name: string; value: string; called: boolean }[];
}

/** The template's own rows and sequence positions, read once per process from an untouched copy. */
let seed: Promise<Seed> | undefined;

async function readSeed(template: string): Promise<Seed> {
  const name = `${poolOf(template)}seed`;
  const admin = adminConnection();
  try {
    await admin`select pg_advisory_lock(hashtext(${name}))`;
    try {
      const [row] = await admin`select 1 from pg_database where datname = ${name}`;
      if (!row) await admin.unsafe(`create database "${name}" template "${template}"`);
    } finally {
      await admin`select pg_advisory_unlock(hashtext(${name}))`;
    }
  } finally {
    await admin.end();
  }
  const sql = postgres(dbUrl(name), { max: 1, onnotice: () => {} });
  try {
    const tables = (await publicTables(sql)).sort();
    const rows = new Map<string, postgres.Row[]>();
    for (const t of tables) {
      const r = await sql`select * from ${sql(t)}`;
      if (r.length > 0) rows.set(t, [...r]);
    }
    const sequences = [];
    for (const {
      name,
    } of await sql`select sequencename as name from pg_sequences where schemaname = 'public'`) {
      const [v] =
        await sql`select last_value::text as value, is_called as called from ${sql(name)}`;
      sequences.push({
        name: name as string,
        value: v?.value as string,
        called: v?.called as boolean,
      });
    }
    return { tables, rows, sequences };
  } finally {
    await sql.end();
  }
}

const publicTables = async (sql: postgres.Sql) =>
  (await sql`select tablename from pg_tables where schemaname = 'public'`).map(
    (r) => r.tablename as string,
  );

/**
 * Empties a claimed database back to the template's state: ends any connection a previous user left behind,
 * truncates every table, restores the seeded rows and puts every sequence back where the template had it. Returns false when its tables no longer match the
 * template's (a test changed the schema), for the caller to recreate it.
 */
async function reset(admin: postgres.Sql, name: string, template: string): Promise<boolean> {
  if (!seed) {
    seed = readSeed(template);
    seed.catch(() => {
      seed = undefined;
    });
  }
  const s = await seed;
  await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
  const sql = postgres(dbUrl(name), { max: 1, onnotice: () => {} });
  try {
    const tables = (await publicTables(sql)).sort();
    if (tables.join() !== s.tables.join()) return false;
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `truncate ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`,
      );
      for (const [t, rows] of s.rows) await tx`insert into ${tx(t)} ${tx(rows)}`;
      for (const q of s.sequences)
        await tx`select setval(${`"${q.name}"`}, ${q.value}::bigint, ${q.called})`;
    });
    return true;
  } finally {
    await sql.end();
  }
}

/** Claims the lowest free pooled database, creating it from the template when it doesn't exist yet. */
async function claimPooled(template: string): Promise<string> {
  holder ??= adminConnection();
  const pool = poolOf(template);
  if (!swept) {
    swept = true;
    await sweepOtherPools(holder, pool);
  }
  for (let n = 0; ; n++) {
    const name = `${pool}${n}`;
    if (claimed.has(name) || !(await tryLock(holder, name))) continue;
    claimed.add(name);
    try {
      const [row] = await holder`select 1 from pg_database where datname = ${name}`;
      if (row && (await reset(holder, name, template))) return name;
      if (row) await holder.unsafe(`drop database "${name}" with (force)`);
      await holder.unsafe(`create database "${name}" template "${template}"`);
      return name;
    } catch (e) {
      await release(name);
      throw e;
    }
  }
}

async function release(name: string) {
  claimed.delete(name);
  if (holder) await unlock(holder, name);
}

export interface MigratedTestDatabase {
  url: string;
  /** Gives the database back to the pool (its rows stay until the next claim resets it). */
  release(): Promise<void>;
}

/**
 * A database with every migration applied and no rows beyond what the migrations seed, from the pool. Call
 * release() when done; a database still claimed when its process ends is free for the next claim.
 */
export async function createMigratedTestDatabase(): Promise<MigratedTestDatabase> {
  const name = await claimPooled(await migratedTemplate());
  return { url: dbUrl(name), release: () => release(name) };
}
