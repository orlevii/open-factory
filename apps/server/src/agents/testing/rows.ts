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
  a: { id: string; slug: string; sessionId?: string | null; status?: string },
): Promise<void> {
  const credId = `cred-${a.id}`;
  await sql`insert into credentials (id, name, kind, value_enc)
            values (${credId}, ${`cred-${a.id}`}, 'oauth_token', ${Buffer.from("dummy")})`;
  await sql`insert into agents (id, slug, display_name, session_id, status, template, config, runtime, credential_id)
            values (${a.id}, ${a.slug}, 'Dev agent', ${a.sessionId ?? null}, ${a.status ?? "hibernated"},
                    'test', ${JSON.stringify(CONFIG)}::jsonb, 'local', ${credId})`;
}
