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
  // No warmWindowMinutes: like a template that omits it, the runtime uses the factory default (S10 §8.2).
};

/** A minimal agent row (plus a credential row with a dummy blob) for tests that don't start real agents. */
export async function insertAgent(
  sql: postgres.Sql,
  a: {
    id: string;
    slug: string;
    sessionId?: string | null;
    status?: string;
    /** Pins the warm window in the config snapshot; omitted by default. */
    warmWindowMinutes?: number;
    displayName?: string;
    reportsTo?: string | null;
    archived?: boolean;
    archivedAt?: Date | string | null;
    errorKind?: string | null;
    /** A terminated agent is ephemeral (a DB check): it needs a `reportsTo`. */
    terminatedAt?: Date | string | null;
    /** Defaults to ephemeral when terminated, else persistent. An ephemeral agent needs a `reportsTo`. */
    kind?: "persistent" | "ephemeral";
  },
): Promise<void> {
  const credId = `cred-${a.id}`;
  await sql`insert into credentials (id, name, kind, value_enc)
            values (${credId}, ${`cred-${a.id}`}, 'oauth_token', ${Buffer.from("dummy")})`;
  await sql`insert into agents (id, slug, display_name, session_id, status, template, config, runtime, credential_id, reports_to, archived_at, error_kind, kind, terminated_at, terminated_by)
            values (${a.id}, ${a.slug}, ${a.displayName ?? "Dev agent"}, ${a.sessionId ?? null}, ${a.status ?? "hibernated"},
                    'test', ${JSON.stringify({ ...CONFIG, ...(a.warmWindowMinutes !== undefined ? { warmWindowMinutes: a.warmWindowMinutes } : {}) })}::jsonb, 'local', ${credId},
                    ${a.reportsTo ?? null}, ${a.archivedAt ? new Date(a.archivedAt).toISOString() : a.archived ? new Date().toISOString() : null}, ${a.errorKind ?? null}, ${a.kind ?? (a.terminatedAt ? "ephemeral" : "persistent")}, ${a.terminatedAt ? new Date(a.terminatedAt).toISOString() : null}, ${a.terminatedAt ? "@factory" : null})`;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A turn row with its usage. `endedAt` defaults to a minute after the start (`null` leaves the turn open); usage defaults to NULL. */
export async function insertTurn(
  sql: postgres.Sql,
  t: {
    id: string;
    agentId: string;
    startedAt: Date;
    endedAt?: Date | null;
    costUsd?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheWriteTokens?: number | null;
    cacheReadTokens?: number | null;
    model?: string | null;
    taskId?: string | null;
    credentialId?: string | null;
  },
): Promise<void> {
  const ended = t.endedAt === undefined ? new Date(t.startedAt.getTime() + 60_000) : t.endedAt;
  await sql`insert into turns (id, agent_id, started_at, ended_at, cost_usd, input_tokens, output_tokens, cache_write_tokens,
                               cache_read_tokens, model, task_id, credential_id)
            values (${t.id}, ${t.agentId}, ${iso(t.startedAt)}, ${iso(ended)},
                    ${t.costUsd == null ? null : t.costUsd.toFixed(6)}, ${t.inputTokens ?? null}, ${t.outputTokens ?? null},
                    ${t.cacheWriteTokens ?? null}, ${t.cacheReadTokens ?? null}, ${t.model ?? null}, ${t.taskId ?? null},
                    ${t.credentialId ?? null})`;
}

/** A schedule row (number from the sequence) for tests that don't go through the service. The creator and author are user `u1` unless given. */
export async function insertSchedule(
  sql: postgres.Sql,
  s: {
    id: string;
    targetAgentId: string;
    cron?: string;
    runAt?: Date;
    timezone?: string;
    body?: string;
    createdByUserId?: string | null;
    createdByAgentId?: string | null;
    nextRunAt?: Date | null;
    pausedAt?: Date | null;
    deletedAt?: Date | null;
  },
): Promise<void> {
  const byAgent = s.createdByAgentId ?? null;
  const byUser = byAgent ? null : (s.createdByUserId ?? "u1");
  await sql`insert into schedules (id, target_agent_id, cron, run_at, timezone, body, created_by_agent_id, created_by_user_id,
                                   body_author_agent_id, body_author_user_id, next_run_at, paused_at, deleted_at)
            values (${s.id}, ${s.targetAgentId}, ${s.cron ?? (s.runAt ? null : "0 9 * * *")}, ${iso(s.runAt)},
                    ${s.timezone ?? "UTC"}, ${s.body ?? "Review"}, ${byAgent}, ${byUser}, ${byAgent}, ${byUser},
                    ${iso(s.nextRunAt)}, ${iso(s.pausedAt)}, ${iso(s.deletedAt)})`;
}

/** A pending `scheduled` message row, as the scheduler writes it. */
export async function insertScheduledMessage(
  sql: postgres.Sql,
  m: {
    id: string;
    toAgentId: string;
    scheduleId: string;
    body?: string;
    authorUserId?: string | null;
    authorAgentId?: string | null;
    dueAt?: Date;
    firings?: number;
    late?: boolean;
    state?: string;
    createdAt?: Date;
  },
): Promise<void> {
  const byAgent = m.authorAgentId ?? null;
  const byUser = byAgent ? null : (m.authorUserId ?? "u1");
  await sql`insert into messages (id, kind, to_agent_id, schedule_id, author_agent_id, author_user_id, due_at, firings, late, body, state, created_at)
            values (${m.id}, 'scheduled', ${m.toAgentId}, ${m.scheduleId}, ${byAgent}, ${byUser},
                    ${iso(m.dueAt ?? new Date("2026-11-23T08:00:00Z"))}, ${m.firings ?? 1}, ${m.late ?? false},
                    ${m.body ?? "Review"}, ${m.state ?? "pending"}, ${iso(m.createdAt ?? new Date())})`;
}
