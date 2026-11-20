import type postgres from "postgres";

const CONFIG = {
  name: "test",
  displayName: "Test agent",
  description: "",
  runtime: "local",
  permissionMode: "auto",
  projects: [],
  skills: [],
  localSkills: true,
  plugins: [],
  secrets: [],
  canSpawn: [],
  maxLiveSpawns: 5,
  warmWindowMinutes: 70,
};

/** A minimal agent row (plus a credential row with a dummy blob) for tests that don't start real agents. */
export async function insertAgent(
  sql: postgres.Sql,
  a: {
    id: string;
    slug: string;
    sessionId?: string | null;
    status?: string;
    warmWindowMinutes?: number;
    displayName?: string;
    reportsTo?: string | null;
    archived?: boolean;
    archivedAt?: Date | string | null;
    errorKind?: string | null;
    /** A terminated agent is ephemeral (a DB check): it needs a `reportsTo`. */
    terminatedAt?: Date | string | null;
  },
): Promise<void> {
  const credId = `cred-${a.id}`;
  await sql`insert into credentials (id, name, kind, value_enc)
            values (${credId}, ${`cred-${a.id}`}, 'oauth_token', ${Buffer.from("dummy")})`;
  await sql`insert into agents (id, slug, display_name, session_id, status, template, config, runtime, credential_id, reports_to, archived_at, error_kind, kind, terminated_at, terminated_by)
            values (${a.id}, ${a.slug}, ${a.displayName ?? "Dev agent"}, ${a.sessionId ?? null}, ${a.status ?? "hibernated"},
                    'test', ${JSON.stringify({ ...CONFIG, ...(a.warmWindowMinutes ? { warmWindowMinutes: a.warmWindowMinutes } : {}) })}::jsonb, 'local', ${credId},
                    ${a.reportsTo ?? null}, ${a.archivedAt ? new Date(a.archivedAt).toISOString() : a.archived ? new Date().toISOString() : null}, ${a.errorKind ?? null}, ${a.terminatedAt ? "ephemeral" : "persistent"}, ${a.terminatedAt ? new Date(a.terminatedAt).toISOString() : null}, ${a.terminatedAt ? "@factory" : null})`;
}
